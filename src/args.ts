/** try-style option extraction: options may appear anywhere, `--name VALUE` or `--name=VALUE`, last one wins. */
export function takeOption(args: string[], name: string): string | undefined {
  let value: string | undefined;
  for (;;) {
    const i = args.findLastIndex((a) => a === name || a.startsWith(`${name}=`));
    if (i < 0) return value;
    const arg = args[i]!;
    let v: string | undefined;
    if (arg.includes("=")) {
      v = arg.slice(arg.indexOf("=") + 1);
      args.splice(i, 1);
    } else {
      v = args[i + 1];
      args.splice(i, v === undefined ? 1 : 2);
    }
    // last occurrence wins; earlier ones are removed too
    if (value === undefined) value = v ?? "";
  }
}

/** Repeated option: all values in order of appearance. */
export function takeOptions(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; ) {
    const arg = args[i]!;
    if (arg === name) {
      values.push(args[i + 1] ?? "");
      args.splice(i, 2);
    } else if (arg.startsWith(`${name}=`)) {
      values.push(arg.slice(name.length + 1));
      args.splice(i, 1);
    } else i++;
  }
  return values;
}

export function takeFlag(args: string[], ...names: string[]): boolean {
  let found = false;
  for (const name of names) {
    let i: number;
    while ((i = args.indexOf(name)) >= 0) {
      args.splice(i, 1);
      found = true;
    }
  }
  return found;
}

/** Split at a literal `--`: everything after it is positional and never parsed as options. */
export function splitDashDash(args: string[]): [string[], string[]] {
  const i = args.indexOf("--");
  return i < 0 ? [args, []] : [args.slice(0, i), args.slice(i + 1)];
}
