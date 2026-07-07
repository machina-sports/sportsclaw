# Corinthians Intelligence — sportsclaw tenant

A per-tenant sportsclaw relay for the Corinthians football department (CIFUT). The relay is the agent runtime (personas + reasoning); the **Corinthians Intelligence Machina drop** is its pod memory + domain documents/tools.

## Design
- **Personas** (`agents/*.md`): O Olheiro (scouting/recrutamento), O Analista de Adversário (pré-jogo), O Diretor de Futebol (ações/risco/digest). Mounted read-only into the relay's agents dir via ConfigMap.
- **Data**: `SPORTSCLAW_SKILLS=football,news` — sports-skills only (ESPN/Transfermarkt/Understat + sports-news). **No SportRadar / "sportsdata". No odds/betting skills.**
- **Pod link**: `SPORTSCLAW_MCP_SERVERS` → the drop's `/mcp`. The relay uses it as PodMemoryStorage (document CRUD) and surfaces its workflows/connectors as `mcp__corinthians-intelligence__*` tools.

## Deploy
```bash
# 1. Fill secrets (never commit real values)
#    - ANTHROPIC_API_KEY  (or swap to GOOGLE_/OPENAI_ if you change SPORTSCLAW_PROVIDER)
#    - SPORTSCLAW_MCP_TOKEN_CORINTHIANS_INTELLIGENCE  (the drop token)
vi secrets.env

# 2. Apply
kubectl apply -k docker/relay/k8s/overlays/corinthians-intelligence

# 3. Verify
kubectl get pods -n sportsclaw -l sportsclaw-user=corinthians-intel
kubectl logs  -n sportsclaw -l sportsclaw-user=corinthians-intel -f   # look for: mcp "corinthians-intelligence" connected; N agents loaded

# 4. Test
kubectl port-forward -n sportsclaw svc/corinthians-intel-sportsclaw-relay 8080:80
curl -s localhost:8080/health
curl -s -X POST localhost:8080/api/query/sync -H 'content-type: application/json' \
  -d '{"query":"Monte a shortlist de zagueiros sub-25 para a sucessão da zaga"}'
```

## Open items (need a decision / owner)
- **LLM provider + key** — `google` (same as adidas); set `GOOGLE_GENERATIVE_AI_API_KEY` in `secrets.env`.
- **Deploy access** — who runs `kubectl apply -k` against the `sportsclaw` cluster.
- **Seed the drop** — load the verified Corinthians knowledge (dossiers `ci-scout-*`, squad `ci-elenco-*`, reports `ci-report-*`) so personas answer from real data. Done via the drop's MCP/REST (`create_document`), gated on authorization.
- **Persona mount path** assumes container `HOME=/root`. If the base image changes the user, update `mountPath` in `kustomization.yaml`.
