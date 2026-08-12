#!/usr/bin/env bash
set -euo pipefail

# Tell the user to run `pa update`, not `pi update`, when a new pi is released.
#
# THE HAZARD
#   pi checks for a newer release and shows a banner: "New version X is
#   available. Run pi update". Inside this sandbox that instruction is wrong in a
#   way that wastes the user's time and, worse, looks like it worked:
#
#     - pi is installed globally in the IMAGE. `pi update` npm-installs a new one
#       into the container's filesystem, which is destroyed on exit. The next `pa`
#       is back on the old version, and the banner returns.
#     - It is also a download of pi for a container that already had one, on top
#       of the sandbox image the user has already pulled.
#     - The image pins more than pi: extensions, baked models, runtimes and the
#       patches in this directory. A pi upgraded underneath them is a combination
#       nobody built or tested.
#
#   Pulling the image is what "update pi" means here, and `pa update` does that.
#
# THE FIX
#   Rewrite that one instruction to name the launcher instead. PA_UPDATE_COMMAND
#   sets it, defaulting to `pa update`, so a differently named launcher can say its
#   own name without another patch.
#
#   Only the *advice* changes. `pi update` still exists and still works if someone
#   runs it deliberately -- this is a signpost, not a lock.
#
# WHAT IS DELIBERATELY LEFT ALONE
#   The sibling "Package Updates Available -- run pi update --extensions" banner.
#   That advice is still the best available: pi packages install under
#   ~/.pi/agent/npm, which pa does not mount, so they are as ephemeral as pi
#   itself -- but `pa update` would not update them at all, whereas
#   `pi update --extensions` does, for the session you are in. Redirecting it
#   would replace imperfect advice with wrong advice.
#
# WHY PATCH INSTEAD OF CONFIGURE
#   The string is built from APP_NAME, which is also the CLI's own name in help
#   output, the TUI title and every other self-reference. pi does support renaming
#   it (package.json `piConfig.name`), but that would relabel the whole program
#   "pa" -- including `pi --help`, which is still the right command to type inside
#   the container. Two sentences are the smaller change.
#
#   Same idiom as install-pi.sh and patch-rag-batch.sh: assert the anchor, fail
#   the build if upstream restructures.

PI_DIR="${PI_DIR:-$(npm root -g)/@earendil-works/pi-coding-agent}"
FILE="${1:-$PI_DIR/dist/modes/interactive/interactive-mode.js}"
[ -f "$FILE" ] || { echo "pi interactive-mode.js not found at $FILE" >&2; exit 1; }

node - "$FILE" <<'PATCH'
const fs = require("fs");

const file = process.argv[2];
let src = fs.readFileSync(file, "utf8");

// The launcher name is read at runtime, so one image serves a launcher called
// something else without rebuilding.
const command = '(process.env.PA_UPDATE_COMMAND || "pa update")';

// The new-pi-release banner only. Its anchor has no --extensions, so it cannot
// match the package-updates banner beneath it.
const edits = [
  {
    what: "new-version banner",
    from: 'const action = theme.fg("accent", `${APP_NAME} update`);',
    to: `const action = theme.fg("accent", ${command});`,
  },
];

let applied = 0;

for (const edit of edits) {
  if (src.includes(edit.to)) {
    console.log(`update-command patch: ${edit.what} already patched`);
    continue;
  }

  const count = src.split(edit.from).length - 1;
  if (count !== 1) {
    throw new Error(
      `update-command patch: expected 1 anchor for the ${edit.what}, found ${count}. ` +
        "Upstream changed its update notification; patch-update-command.sh needs updating.",
    );
  }

  src = src.replace(edit.from, edit.to);
  applied += 1;
}

if (applied === 0) {
  process.exit(0);
}

fs.writeFileSync(file, src);
console.log(`update-command patch applied (${applied} banner(s) now say \`pa update\`)`);
PATCH
