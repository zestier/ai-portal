/**
 * The streamed think-tag splitter shared by the tool-calling extractor's
 * render path. The HTTP transport that used to live here (raw SSE to an
 * OpenAI-compatible endpoint) was replaced by the pi completion seam in
 * `$lib/server/pi/complete`; only the pure text processing survives.
 */
export function makeThinkStream() {
	const openTags = ['<think>', '<thinking>'];
	const closeTags = ['</think>', '</thinking>'];
	const allTags = [...openTags, ...closeTags];
	const maxLen = Math.max(...allTags.map((tag) => tag.length));
	const couldBePrefix = (s: string) => allTags.some((tag) => tag.startsWith(s));
	let inThink = false;
	let pending = '';

	const drain = (): { think: string; visible: string } => {
		let think = '';
		let visible = '';
		const append = (text: string) => {
			if (!text) return;
			if (inThink) think += text;
			else visible += text;
		};
		while (pending.length > 0) {
			const lt = pending.indexOf('<');
			if (lt === -1) {
				append(pending);
				pending = '';
				break;
			}
			append(pending.slice(0, lt));
			pending = pending.slice(lt);
			const openMatch = openTags.find((tag) => pending.startsWith(tag));
			if (openMatch) {
				inThink = true;
				pending = pending.slice(openMatch.length);
				continue;
			}
			const closeMatch = closeTags.find((tag) => pending.startsWith(tag));
			if (closeMatch) {
				inThink = false;
				pending = pending.slice(closeMatch.length);
				continue;
			}
			if (pending.length < maxLen && couldBePrefix(pending)) break;
			append('<');
			pending = pending.slice(1);
		}
		return { think, visible };
	};

	return {
		push(chunk: string): { think: string; visible: string } {
			pending += chunk;
			return drain();
		},
		flush(): { think: string; visible: string } {
			const rest = pending;
			pending = '';
			if (!rest) return { think: '', visible: '' };
			return inThink ? { think: rest, visible: '' } : { think: '', visible: rest };
		}
	};
}
