# ADR-0003 — Model-off demo first

- Date: 2026-10-25 local.
- Status: Accepted; deterministic engine and disabled provider now implemented
  and unit tested. No model/runtime is installed or selected.

Use a deterministic, model-disabled P0 demonstration before adding a local model.
This is explicitly allowed by the blueprint and avoids making hardware, license
or inference quality claims without measurements. Ollama was unavailable on PATH.

Deterministic extraction, field-specific questions and an approved existing
fixture test must still complete the loop. Preserve a typed provider boundary
for later schema-constrained suggestions; the model never authorizes execution
or determines outcome. Model outage must result in fallback or an honest block.

Gemma 4 remains an unevaluated candidate. Before enabling any model, B must record
its exact release/source, license/redistribution terms, runtime/version,
quantization, context cap, measured RAM/latency and benchmark results on this Mac.
Structured validity and unsupported factual claims must be measured, not inferred
from marketing or runtime support. No model is bundled or called today.
