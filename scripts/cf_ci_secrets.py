#!/usr/bin/env python3
"""Mint the minimal Cloudflare API token for CI and register it as GitHub
secrets — without any secret value ever being printed, logged, or written to
disk. Stdlib only, like the repo's other scripts.

Credential flow (values live in memory and move only through pipes):

    ONE-TIME bootstrap ACCOUNT token                wrangler OAuth session
    (owner creates it in the dashboard with         (~/.config/.wrangler — the
    Account 'API Tokens: Write' + 'Account          script keeps its access
    Settings: Read' + Zone 'Zone: Read',            token fresh via wrangler
    deposits it at ~/.config/flambette/             itself, never the dash WAF)
    cf-bootstrap-token, chmod 600)
              │                                              │
              ▼                                              ▼
    Cloudflare API: mint a named, minimal    reads: accounts, zone, the
    ACCOUNT token scoped to exactly what     permission-group catalog
    the workflows need (deploy + preview)
              │
              ▼
    `gh secret set CLOUDFLARE_API_TOKEN`  ◀─ token value, stdin only
    `gh secret set CLOUDFLARE_ACCOUNT_ID` ◀─ account id, stdin only

wrangler's OAuth session CANNOT mint API tokens (that right is outside its
scopes — verified: HTTP 9109 on the tokens API), so the bootstrap token is
required once. The minted token is an ACCOUNT-owned token via
/accounts/{id}/tokens — account-owned tokens accept ONLY account-scoped
resources (both zone-scoped resource shapes are rejected with error 1001),
so the zone groups (Zone Read, Workers Routes Write) attach to the account
and apply to its zones. Re-running the script ROLLS the CI token (the
previous same-named token is deleted after the new secret lands) — so the
bootstrap file must be KEPT: wrangler's OAuth cannot manage tokens, and a
later rotation without the bootstrap file stops at the capability check.

Usage (from the repo root):
    python3 scripts/cf_ci_secrets.py --dry-run   # auth + plan; mint nothing
    python3 scripts/cf_ci_secrets.py             # mint + set secrets + roll old
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API_BASE = "https://api.cloudflare.com/client/v4"
WRANGLER_CONFIG = Path.home() / ".config" / ".wrangler" / "config" / "default.toml"
BOOTSTRAP_FILE = Path.home() / ".config" / "flambette" / "cf-bootstrap-token"
TOKEN_NAME = "flambette-ci (github actions)"
ZONE_NAME = "flambette.app"

# The token is scoped to exactly what release.yml + preview.yml exercise:
# `wrangler deploy` (both workers, incl. the custom domains' routes) and
# `wrangler preview`. Permission-group names from the Cloudflare catalog,
# matched case-insensitively — group IDS differ per account, names don't.
ACCOUNT_GROUPS = ["Workers Scripts Write", "Account Settings Read"]
ZONE_GROUPS = ["Zone Read", "Workers Routes Write"]


class CfError(RuntimeError):
    """A failed step. Messages carry status/codes only — never token values."""


def _cf(method: str, path: str, token: str, body: dict | None = None) -> dict:
    """One Cloudflare API call. SUCCESSFUL token responses contain the token
    value, so callers extract the fields they need and nothing prints them."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API_BASE + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.load(resp)
    except urllib.error.HTTPError as e:
        try:
            errors = json.load(e).get("errors", [])
            detail = "; ".join(
                f"{err.get('code')}: {err.get('message')}" for err in errors
            )
        except Exception:
            detail = "(unreadable error body)"
        raise CfError(f"{method} {path} -> HTTP {e.code}: {detail}") from None
    if not payload.get("success"):
        raise CfError(f"{method} {path}: {payload.get('errors')}")
    return payload


def _access_token() -> str:
    """The credential allowed to MINT the CI token: a bootstrap token if the
    owner deposited one, else wrangler's OAuth session. Wrangler stores the
    ACCESS token under `oauth_token` with its `expiration_time`, and the
    REFRESH token under the separate `refresh_token` key."""
    bootstrap = os.environ.get("CLOUDFLARE_API_TOKEN_BOOTSTRAP")
    if bootstrap:
        return bootstrap
    if BOOTSTRAP_FILE.is_file():
        return BOOTSTRAP_FILE.read_text().strip()
    return _fresh_access_from_wrangler()


def _fresh_access_from_wrangler() -> str:
    """A fresh wrangler access token, with WRANGLER as the network agent.

    This box's own calls to the dash OAuth endpoint are WAF-blocked
    (error 1010 — client fingerprint), so we never make them: wrangler
    refreshes its own OAuth and persists the access token back into its
    config, so a stale token is fixed by re-running one cheap wrangler
    command and re-reading the config.
    """
    for attempt in (1, 2):
        if not WRANGLER_CONFIG.is_file():
            raise CfError(
                f"no bootstrap credential: {WRANGLER_CONFIG} is missing. "
                "Run `wrangler login` first, or set CLOUDFLARE_API_TOKEN_BOOTSTRAP."
            )
        config = tomllib.loads(WRANGLER_CONFIG.read_text())
        access, expiry = config.get("oauth_token"), config.get("expiration_time")
        if access and expiry:
            try:
                expires = datetime.fromisoformat(str(expiry).replace("Z", "+00:00"))
                if expires > datetime.now(timezone.utc) + timedelta(minutes=5):
                    return access
            except ValueError:
                pass
        if attempt == 1:
            proc = subprocess.run(
                ["wrangler", "whoami"], capture_output=True, text=True, timeout=120
            )
            if proc.returncode != 0:
                raise CfError(
                    f"`wrangler whoami` failed (exit {proc.returncode}); "
                    "run `wrangler login`."
                )
    raise CfError(
        "wrangler's stored access token is stale even after `wrangler whoami`; "
        "run `wrangler login`."
    )


def _repo_from_origin() -> str:
    url = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    match = re.search(r"[:/]([^/]+/[^/.]+?)(?:\.git)?$", url)
    if not match:
        raise CfError(f"cannot derive owner/repo from {url}")
    return match.group(1)


def _gh_secret_set(name: str, value: str, repo: str) -> None:
    """Value travels via stdin only — never an argv (visible in `ps`)."""
    cmd = ["gh", "secret", "set", name, "--repo", repo]
    proc = subprocess.run(cmd, input=value.encode(), capture_output=True)
    if proc.returncode != 0:
        raise CfError(f"gh secret set {name} failed: {proc.stderr.decode().strip()}")


def _can_manage_tokens(token: str, account: str) -> bool:
    """Read-only probe on the ACCOUNT token route: does this credential see
    the account-owned tokens API (the route it must be able to write)?"""
    try:
        _cf("GET", f"/accounts/{account}/tokens?per_page=1", token)
        return True
    except CfError:
        return False


def _roll_old(token: str, account: str, new_id: str, token_name: str, started_at: float) -> None:
    """Delete same-named predecessors — but only ones OLDER than this
    invocation: a token created after this run started belongs to a CONCURRENT
    invocation, and deleting it would revoke the credential that run just
    wrote to the GitHub secret (review #3). The walk paginates every page so a
    predecessor beyond the first 50 is still found (review #4)."""
    page = 1
    while page <= 20:  # safety cap against a misbehaving API
        listed = _cf("GET", f"/accounts/{account}/tokens?per_page=50&page={page}", token)["result"]
        if not listed:
            break
        for t in listed:
            if t.get("name") != token_name or t.get("id") == new_id or t.get("status") == "deleted":
                continue
            created = t.get("created_on")
            try:
                created_ts = datetime.fromisoformat(str(created).replace("Z", "+00:00")).timestamp()
            except ValueError:
                created_ts = 0.0
            if created_ts >= started_at - 60:
                continue  # young enough to be a concurrent invocation's token — not ours to delete
            try:
                _cf("DELETE", f"/accounts/{account}/tokens/{t['id']}", token)
                print(f"  rolled old CI token {t['id']}")
            except CfError as e:
                print(f"  (could not roll old token {t['id']}: {e})")
        page += 1


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Mint the Cloudflare CI token and set it as a GitHub secret.",
    )
    ap.add_argument("--dry-run", action="store_true", help="auth + plan only")
    ap.add_argument("--account-id", help="pick the account when several exist")
    ap.add_argument("--repo", help="owner/name for gh (default: the origin remote)")
    ap.add_argument("--token-name", default=TOKEN_NAME)
    args = ap.parse_args()
    started_at = time.time()

    token = _access_token()
    accounts = [(a["id"], a.get("name", "?")) for a in _cf("GET", "/accounts", token)["result"]]
    if args.account_id:
        account = args.account_id
    elif len(accounts) == 1:
        account = accounts[0][0]
    else:
        print("several accounts; pass --account-id (or deposit a bootstrap token scoped to one):")
        for acc_id, name in accounts:
            print(f"  {acc_id}  {name}")
        return 2

    capable = _can_manage_tokens(token, account)
    if not capable:
        print(
            "This credential cannot manage ACCOUNT tokens (the bootstrap must be an\n"
            "account-owned token with 'API Tokens: Write').\n"
            "One-time bootstrap:\n"
            "  1. Cloudflare dashboard → the account's API Tokens page (or My Profile\n"
            "     → API Tokens, custom token) with: Account 'API Tokens: Write' +\n"
            "     'Account Settings: Read', Zone 'Zone: Read' (All zones).\n"
            f"  2. Save the token value to {BOOTSTRAP_FILE} (chmod 600) — never "
            "into a chat.\n"
            "  3. Re-run this script: it mints the minimal 'flambette-ci' "
            "account token,\n"
            "     registers the GitHub secrets, rolls the old CI token, and the\n"
            "     bootstrap file must be KEPT for future rotations (wrangler's\n"
            "     OAuth cannot manage tokens)."
        )
        return 2

    groups = {
        g["name"].lower(): g["id"]
        for g in _cf("GET", f"/accounts/{account}/tokens/permission_groups", token)["result"]
    }
    missing = [g for g in ACCOUNT_GROUPS + ZONE_GROUPS if g.lower() not in groups]
    if missing:
        raise CfError(f"permission groups absent from the catalog: {missing}")

    zones = _cf("GET", f"/zones?name={ZONE_NAME}", token)["result"]
    zone = next((z["id"] for z in zones if z.get("account", {}).get("id") == account), None)
    if not zone:
        raise CfError(f"zone {ZONE_NAME} not found in account {account}")

    print(f"account {account}; zone {ZONE_NAME} ({zone})")
    print("account policy: " + ", ".join(ACCOUNT_GROUPS))
    print("zone policy:    " + ", ".join(ZONE_GROUPS))

    if args.dry_run:
        print("dry-run: auth OK, token management OK — ready to mint + set secrets.")
        return 0

    if not _can_manage_tokens(token, account):
        print(
            "this credential cannot manage account tokens. Remediation: see the "
            "bootstrap instructions at the top of `--help` (deposit an account "
            f"token with API Tokens: Write into {BOOTSTRAP_FILE} and re-run)."
        )
        return 2

    minted = _cf(
        "POST",
        f"/accounts/{account}/tokens",
        token,
        {
            "name": args.token_name,
            # Account-owned tokens accept ONLY account-scoped resources —
            # zone-scoped resource strings are rejected with error 1001, so
            # the zone groups (Zone Read, Workers Routes Write) attach to the
            # account and apply to its zones.
            "policies": [
                {
                    "effect": "allow",
                    "resources": {f"com.cloudflare.api.account.{account}": "*"},
                    "permission_groups": [
                        {"id": groups[g.lower()]} for g in ACCOUNT_GROUPS + ZONE_GROUPS
                    ],
                },
            ],
        },
    )["result"]
    new_id, value = minted["id"], minted["value"]
    secrets_set = 0
    try:
        # Functional probe with the NEW token before registering the secret —
        # the scripts list is the exact right `wrangler deploy`/`preview` build on.
        _cf("GET", f"/accounts/{account}/workers/scripts?per_page=1", value)

        repo = args.repo or _repo_from_origin()
        _gh_secret_set("CLOUDFLARE_API_TOKEN", value, repo)
        secrets_set += 1
        _gh_secret_set("CLOUDFLARE_ACCOUNT_ID", account, repo)
        secrets_set += 1
    except Exception as e:
        if secrets_set == 0:
            # Nothing depends on the minted token yet — revoke it so a failed
            # setup never leaves an active credential behind (review #2).
            try:
                _cf("DELETE", f"/accounts/{account}/tokens/{new_id}", token)
                print(f"revoked the minted token {new_id} (setup failed before any secret was set)")
            except CfError as roll_err:
                print(f"setup FAILED and the minted token {new_id} could NOT be revoked: {roll_err}")
        else:
            # At least one secret is already live against this token — revoking
            # it would break CI. Leave it active; the next successful run rolls it.
            print(
                f"setup failed AFTER {secrets_set} secret(s) were set — the minted "
                f"token {new_id} stays active and is rolled by the next successful run"
            )
        print(f"error: {e}", file=sys.stderr)
        return 2

    _roll_old(token, account, new_id, args.token_name, started_at)

    print(f"set secrets CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID on {repo}")
    print(f"minted CI token id {new_id} (named '{args.token_name}')")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except CfError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(2)
