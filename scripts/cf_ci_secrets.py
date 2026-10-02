#!/usr/bin/env python3
"""Mint the minimal Cloudflare API token for CI and register it as GitHub
secrets — without any secret value ever being printed, logged, or written to
disk. Stdlib only, like the repo's other scripts.

Credential flow (values live in memory and move only through pipes):

    ONE-TIME bootstrap token                       wrangler OAuth session
    (owner creates it in the dashboard             (~/.config/.wrangler — the
    with API Tokens: Edit, deposits it             script keeps its access
    at ~/.config/flambette/                        token fresh via wrangler
    cf-bootstrap-token, chmod 600)                 itself, never the dash WAF)
              │                                              │
              ▼                                              ▼
    Cloudflare API: mint a named, minimal    reads: accounts, zone, the
    token scoped to exactly what the         permission-group catalog
    workflows need (deploy + preview)
              │
              ▼
    `gh secret set CLOUDFLARE_API_TOKEN`  ◀─ token value, stdin only
    `gh secret set CLOUDFLARE_ACCOUNT_ID` ◀─ account id, stdin only

wrangler's OAuth session CANNOT mint API tokens (that right is outside its
scopes — verified: HTTP 9109 on the tokens API), so the bootstrap token is
required once; the script then mints the minimal `flambette-ci (github
actions)` token, which is what CI uses. Re-running the script ROLLS the CI
token (the previous same-named token is deleted after the new secret lands);
the bootstrap file can be deleted after the first run.

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


def _can_manage_tokens(token: str) -> bool:
    """Read-only probe: does this credential even see the tokens API?"""
    try:
        _cf("GET", "/user/tokens?per_page=1", token)
        return True
    except CfError:
        return False


def _roll_old(token: str, new_id: str, token_name: str) -> None:
    listed = _cf("GET", "/user/tokens?per_page=50", token)["result"]
    for t in listed:
        if t.get("name") == token_name and t.get("id") != new_id and t.get("status") != "deleted":
            try:
                _cf("DELETE", f"/user/tokens/{t['id']}", token)
                print(f"  rolled old CI token {t['id']}")
            except CfError as e:
                print(f"  (could not roll old token {t['id']}: {e})")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Mint the Cloudflare CI token and set it as a GitHub secret.",
    )
    ap.add_argument("--dry-run", action="store_true", help="auth + plan only")
    ap.add_argument("--account-id", help="pick the account when several exist")
    ap.add_argument("--repo", help="owner/name for gh (default: the origin remote)")
    ap.add_argument("--token-name", default=TOKEN_NAME)
    args = ap.parse_args()

    token = _access_token()
    capable = _can_manage_tokens(token)
    if not capable:
        print(
            "This credential cannot manage API tokens (wrangler's OAuth scopes "
            "never include that right).\n"
            "One-time bootstrap:\n"
            "  1. Cloudflare dashboard → My Profile → API Tokens → Create Token\n"
            "     (custom) with: User 'API Tokens: Edit', Account 'Account "
            "Settings: Read',\n"
            "     Zone 'Zone: Read' (All zones).\n"
            f"  2. Save the token value to {BOOTSTRAP_FILE} (chmod 600) — never "
            "into a chat.\n"
            "  3. Re-run this script: it mints the minimal 'flambette-ci' "
            "token, registers\n"
            "     the GitHub secrets, rolls the old CI token, and the bootstrap "
            "file can\n"
            "     then be deleted."
        )
        return 2

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

    groups = {g["name"].lower(): g["id"] for g in _cf("GET", "/user/tokens/permission_groups", token)["result"]}
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

    if not _can_manage_tokens(token):
        print(
            "this credential cannot manage API tokens. Remediation: see the "
            "bootstrap instructions at the top of `--help` (deposit a token "
            f"with API Tokens: Edit into {BOOTSTRAP_FILE} and re-run)."
        )
        return 2

    minted = _cf(
        "POST",
        "/user/tokens",
        token,
        {
            "name": args.token_name,
            "policies": [
                {
                    "effect": "allow",
                    "resources": {f"com.cloudflare.api.account.{account}": "*"},
                    "permission_groups": [{"id": groups[g.lower()]} for g in ACCOUNT_GROUPS],
                },
                {
                    "effect": "allow",
                    "resources": {f"com.cloudflare.api.account.{account}.zone.{zone}": "*"},
                    "permission_groups": [{"id": groups[g.lower()]} for g in ZONE_GROUPS],
                },
            ],
        },
    )["result"]
    new_id, value = minted["id"], minted["value"]

    # Verify + a functional probe BEFORE registering the secret.
    verify = _cf("GET", "/user/tokens/verify", value)["result"]
    if verify.get("status") != "active":
        raise CfError(f"minted token {new_id} is not active: {verify.get('status')}")
    _cf("GET", f"/accounts/{account}/workers/scripts?per_page=1", value)

    repo = args.repo or _repo_from_origin()
    _gh_secret_set("CLOUDFLARE_API_TOKEN", value, repo)
    _gh_secret_set("CLOUDFLARE_ACCOUNT_ID", account, repo)
    _roll_old(token, new_id, args.token_name)

    print(f"set secrets CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID on {repo}")
    print(f"minted CI token id {new_id} (named '{args.token_name}')")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except CfError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(2)
