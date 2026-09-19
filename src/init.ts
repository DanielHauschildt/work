import { q, qFish } from "./emit.ts";
import { fail } from "./errors.ts";

export interface Shortcut {
  name: string;
  space: string;
}

export function parseShortcuts(values: string[]): Shortcut[] {
  return values.map((v) => {
    const [name, space] = v.split("=", 2);
    if (!name || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) fail(`invalid shortcut name: ${v}`);
    return { name, space: space || name };
  });
}

/** Command that runs this binary: the compiled executable, or `bun <script>` in development. */
export function selfCommand(): string[] {
  const exe = process.execPath;
  const isBun = /(^|\/)bun(-\w+)?$/.test(exe);
  return isBun ? [exe, Bun.main] : [exe];
}

export function initScript(opts: { root: string; shortcuts: Shortcut[]; shell: "sh" | "fish"; self?: string[] }): string {
  const self = opts.self ?? selfCommand();
  return opts.shell === "fish" ? fishInit(self, opts) : shInit(self, opts);
}

function shInit(self: string[], { root, shortcuts }: { root: string; shortcuts: Shortcut[] }): string {
  const bin = `${self.map(q).join(" ")} --path ${q(root)}`;
  const names = ["work", ...shortcuts.map((s) => s.name)];
  const cases = shortcuts.map((s) => `    ${s.name}) printf '%s' ${q(s.space)} ;;`).join("\n");
  return `# work shell integration (bash/zsh)
work() {
  local __work_emit __work_rc
  __work_emit="$(mktemp "\${TMPDIR:-/tmp}/work.XXXXXX")" || return 1
  WORK_EMIT="$__work_emit" WORK_SHELL=sh command ${bin} "$@"
  __work_rc=$?
  if [ -s "$__work_emit" ]; then . "$__work_emit"; fi
  rm -f "$__work_emit"
  return $__work_rc
}
${shortcuts.map((s) => `${s.name}() { work --space ${q(s.space)} "$@"; }`).join("\n")}
__work_space_for() {
  case "$1" in
${cases}
  esac
}
if [ -n "\${ZSH_VERSION:-}" ]; then
  _work_complete() {
    local __space __line
    local -a __lines __vals __descs
    __space="$(__work_space_for "\${words[1]}")"
    __lines=(\${(f)"$(command ${bin} __complete --shell zsh --cmd "\${words[1]}" --space "$__space" -- "\${(@)words[2,CURRENT]}" 2>/dev/null)"})
    if [[ "\${__lines[1]}" == ":files" ]]; then _files; return; fi
    for __line in "\${__lines[@]}"; do
      __vals+=("\${__line%%$'\\t'*}")
      if [[ "$__line" == *$'\\t'* ]]; then __descs+=("\${__line%%$'\\t'*}  -- \${__line#*$'\\t'}"); else __descs+=("$__line"); fi
    done
    (( \${#__vals} )) && compadd -U -l -d __descs -- "\${__vals[@]}"
  }
  if (( \${+functions[compdef]} )); then compdef _work_complete ${names.join(" ")}; fi
elif [ -n "\${BASH_VERSION:-}" ]; then
  _work_complete() {
    local IFS=$'\\n' __space
    __space="$(__work_space_for "\${COMP_WORDS[0]}")"
    COMPREPLY=($(command ${bin} __complete --shell bash --cmd "\${COMP_WORDS[0]}" --space "$__space" -- "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null))
    if [ "\${COMPREPLY[0]:-}" = ":files" ]; then COMPREPLY=($(compgen -f -- "\${COMP_WORDS[COMP_CWORD]}")); fi
  }
  complete -F _work_complete ${names.join(" ")}
fi
`;
}

function fishInit(self: string[], { root, shortcuts }: { root: string; shortcuts: Shortcut[] }): string {
  const bin = `${self.map(qFish).join(" ")} --path ${qFish(root)}`;
  const complete = (name: string, space: string) =>
    `complete -c ${name} -f -a '(${bin.replaceAll("'", "\\'")} __complete --shell fish --cmd ${name} --space ${space} -- (commandline -opc)[2..-1] (commandline -ct) 2>/dev/null)'`;
  return `# work shell integration (fish)
function work
  set -q TMPDIR; or set -l TMPDIR /tmp
  set -l __work_emit (mktemp "$TMPDIR/work.XXXXXX"); or return 1
  env WORK_EMIT=$__work_emit WORK_SHELL=fish ${bin} $argv
  set -l __work_rc $status
  if test -s $__work_emit
    source $__work_emit
  end
  rm -f $__work_emit
  return $__work_rc
end
${shortcuts.map((s) => `function ${s.name}\n  work --space ${qFish(s.space)} $argv\nend`).join("\n")}
${complete("work", "''")}
${shortcuts.map((s) => complete(s.name, qFish(s.space))).join("\n")}
`;
}
