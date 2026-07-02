// ─── Helpers ────────────────────────────────────────────────

export function resolveModels(registry: any, models: string[]): any[] {
	return models
		.map((id) => {
			const slashIdx = id.indexOf("/");
			if (slashIdx > 0) {
				return registry.find(id.slice(0, slashIdx), id.slice(slashIdx + 1));
			}
			return null;
		})
		.filter(Boolean);
}

export function resolveOneModel(registry: any, modelId: string): any {
	if (!modelId) return null;
	const slashIdx = modelId.indexOf("/");
	if (slashIdx > 0) {
		return registry.find(modelId.slice(0, slashIdx), modelId.slice(slashIdx + 1));
	}
	return null;
}

export function autoDiversePanel(registry: any): any[] {
	const available = registry.getAvailable();
	if (!available || available.length === 0) return [];

	const byProvider: Record<string, any[]> = {};
	for (const m of available) {
		const provider = m.provider || "unknown";
		if (!byProvider[provider]) byProvider[provider] = [];
		byProvider[provider].push(m);
	}

	const picked: any[] = [];
	const providers = Object.keys(byProvider).sort();
	for (let i = 0; i < 2; i++) {
		for (const provider of providers) {
			const models = byProvider[provider];
			if (models.length > i) {
				const model = models[i];
				if (!picked.find((p) => p.id === model.id && p.provider === model.provider)) {
					picked.push(model);
					if (picked.length >= 2) return picked;
				}
			}
		}
	}

	return picked.slice(0, 2);
}
