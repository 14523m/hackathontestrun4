# Responsible AI & transparency

Heat predictions in HK CoolPath AI are **estimates**, and the demo must make
that impossible to miss.

## What the app claims — and does not claim

| Claim | Status |
|---|---|
| Heat Exposure Score (0-100) at street level | **Modelled estimate** from HKO atmospheric anchors + urban geometry. Never a measurement. |
| "Temperature measured here: 34.2°C" | **Never shown** unless a real sensor exists at that spot. |
| HKO station observations (live mode) | Observed. Served **STALE** (flagged) if the feed drops — never silently replaced with fabricated values. |
| Mock geodata (network/buildings/land use/cooling spots) | Simulated, geographically plausible, deterministic. Labelled "simulated" in the UI. |
| Northern Metropolis layer | **CONCEPTUAL / SIMULATED planning scenario.** Not an official plan and not a prediction about the real Northern Metropolis. |
| Planning metrics | Simulated scenario outputs from a prototype model. Not sufficient for real planning decisions alone. |

## Principles implemented

1. **Explainability over scores.** Every prediction carries signed factor
   contributions; the UI answers "why is this area hot?" rather than showing
   an unexplained number.
2. **Provenance visible.** The Data Sources panel (`/config/data-sources`,
   mirrored in docs/data-sources.md) lists each source, its status
   (live / simulated / not yet integrated) and a link to the official site.
   The mode badge (`LIVE` / `LIVE · STALE` / `DEMO · SIMULATED`) is always on.
3. **No replacement for official warnings.** The app does not replace HKO
   heat warnings; the disclaimer states this explicitly.
4. **Validation before deployment.** Real use requires calibration against
   ground measurements and published models; the demo model's weights are
   documented prototype calibration parameters, not fitted science.
5. **Data minimisation.** No user accounts; demo trips are hardcoded; the
   app never stores location history.
6. **Anonymised crowd reports.** Reports carry no user identifiers; a real
   submission API must preserve this and add abuse validation.
7. **Equity metrics handled with care.** The Cooling Access Gap is a labelled
   prototype metric. Real demographic/vulnerability analysis must only use
   such data where legally and ethically appropriate, and planning decisions
   must never be made from an AI score alone.
