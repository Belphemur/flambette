/**
 * Bun's built-in `bun:sqlite` module, declared STRUCTURALLY (ADR-0088 §1):
 * the repo ships no `@types/bun` — and the ADR forbids adding one — so the
 * adapter declares only the members it actually touches, in the same
 * spirit as `relay.ts`'s structural `Bun.serve` declaration. An ambient
 * file rather than a `declare module` block inside a module, because tsc
 * cannot resolve the non-npm module name to augment it there.
 */

declare module 'bun:sqlite' {
  export class Database {
    constructor(path?: string, options?: { readonly?: boolean; create?: boolean })
    /** Run one statement (DDL or DML). No bindings. */
    exec(sql: string): void
    /**
     * A cached prepared statement. `run` executes with bindings; `all`
     * reads every row of a SELECT as column-name → value records.
     */
    query(sql: string): {
      run: (...bindings: unknown[]) => unknown
      all: (...bindings: unknown[]) => Record<string, unknown>[]
    }
    /**
     * A transaction: the callable it returns runs the function inside one
     * SQLite transaction — committed when the function returns, rolled
     * back when it throws. The adapter only CALLS the result, so the
     * declaration shows just the callable face.
     */
    transaction<Args extends readonly unknown[]>(
      fn: (...args: Args) => unknown,
    ): (...args: Args) => void
    close(): void
  }
}
