---
name: phase-check
description: Verifies the current Questa Booking phase meets its definition of done before reporting to the project owner. Use at the end of every phase, before asking for review or creating a git tag, or when the user asks whether a phase is finished.
---

# Phase check

Run every check below, in order, from the repo root. Report each one as PASS or FAIL with the evidence (command output or file path). Never mark a check PASS without running it in this session.

## 1. Clean start

```bash
docker compose down -v
docker compose up -d --build
```

Wait until `docker inspect -f '{{.State.Health.Status}}' questa-api-1` is `healthy`, then:

```bash
curl -s localhost:${API_PORT:-3000}/api/v1/health/ready
```

PASS only if it returns `"status":"ok"` with every check `up`.

## 2. Code quality and tests

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e
```

## 3. Phase acceptance criteria

Open `docs/spec.md` section 10, find the current phase (named in `AGENTS.md`), and check each "Hoàn thành khi" item one by one with evidence. For invariants (I1–I12) introduced in this phase, name the test that proves each one.

## 4. Documentation

- [ ] Swagger lists every endpoint that exists (from phase 1 on).
- [ ] `README.md` and `README.vi.md` both updated, same structure and numbers.
- [ ] New ADRs in `docs/adr/` for decisions made in this phase.
- [ ] Learning note `docs/learning/phase-NN-*.md` for this phase.
- [ ] The text documentation above stands on its own: a reader understands the phase without the showcase.
- [ ] Supplementary showcase `docs/showcase/phase-NN/`: Mermaid diagrams in `README.md`, a demo page that works against the running API (open it in the browser and click through every section; no console errors), and `video/phase-NN.mp4` built from `video/slides.html`. The phase card in `docs/showcase/index.html` is updated.
- [ ] From phase 2 on: new row in `docs/benchmarks.md`.
- [ ] `.env.example` contains every variable in `apps/api/src/config/env.schema.ts`.

## 5. Git hygiene

```bash
git status --short
git diff --cached | grep -inE "password|secret|api_key|private_key" || true
```

Working tree clean or only intended changes; no secrets staged.

## Report

End with a short report in Vietnamese for the project owner:

1. What was built in this phase.
2. Table of checks: PASS/FAIL.
3. Decisions made (ADR links) and anything that deviated from the spec.
4. The proposed tag name. Do **not** create the tag; wait for the owner's approval.
