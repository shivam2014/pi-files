# vision-router

Image questions land on a vision-capable model automatically.

## What it solves

Not every model in the registry can read images. vision-router forwards image questions to a model that can, so you can ask about a screenshot or diagram without switching your main model.

## Commands and tools

- `/vision <query>` — route a query to the configured vision model.
- `/vision-config` — pick any model (vision-capable ones are highlighted).
- `vision_query` (tool) — LLM-routable vision tool.

## Config

`~/.pi/agent/vision-router.json`:

```json
{
  "visionModel": "provider/modelId",
  "instructions": "optional system instructions for the vision model"
}
```

- `visionModel` is `"provider/modelId"`, looked up in the model registry. A legacy `{ "provider", "model" }` pair is also accepted and folded into `visionModel`.
- `instructions` defaults to a generic vision-specialist prompt.
- Model capabilities are read from a local `/v1/models` endpoint when available, so the config picker can highlight vision-capable models.

## Usage

```
/vision describe what's in this screenshot
```
