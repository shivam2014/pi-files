import type { AssistantMessage } from "@earendil-works/pi-ai";

export function extractText(response: AssistantMessage): string {
	const textBlocks = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text);
	const text = textBlocks.join("\n");
	if (text) {
		return text;
	}
	return response.content
		.filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking")
		.map((c) => c.thinking)
		.join("\n");
}

export function mapWithConcurrencyLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	return new Promise((resolve, reject) => {
		if (items.length === 0) {
			resolve([]);
			return;
		}
		const results: R[] = new Array(items.length);
		let index = 0;
		let running = 0;
		let rejected = false;

		function next() {
			if (rejected) return;
			if (index >= items.length) {
				if (running === 0) resolve(results);
				return;
			}
			const current = index++;
			running++;
			fn(items[current])
				.then((result) => {
					results[current] = result;
					running--;
					next();
				})
				.catch((err) => {
					rejected = true;
					reject(err);
				});
		}

		for (let i = 0; i < Math.min(limit, items.length); i++) {
			next();
		}
	});
}
