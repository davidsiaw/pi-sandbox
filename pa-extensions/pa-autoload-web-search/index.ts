/**
 * pa-autoload-web-search
 *
 * Automatically loads the web-search skill on startup by hooking into the
 * resources_discover event and adding the skill path dynamically.
 *
 * This ensures the web-search skill is always available without the user
 * needing to manually load it via /skill:web-search.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// Hook into resources_discover to add the web-search skill path
	pi.on("resources_discover", (event, ctx) => {
		ctx.ui.notify("[pa-autoload-web-search] Adding web-search skill dynamically...", "info");
		return {
			skillPaths: ["/opt/pa/skills/web-search/SKILL.md"],
		};
	});
}
