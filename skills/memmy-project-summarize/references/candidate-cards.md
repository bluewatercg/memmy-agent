# Candidate Cards

Create only candidates that reduce future project rediscovery.

## Layers

- `L2`: a reusable project decision, working convention, successful approach, or failure lesson.
- `L3`: a stable architecture fact, system constraint, ownership boundary, or long-term rule confirmed by current project evidence.
- `Skill`: a repeatable executable workflow with a detectable trigger, ordered steps, and a concrete verification method.

## Card Format

```text
[L2 | L3 | Skill] Title

Conclusion:
One precise, self-contained conclusion.

Evidence:
- Current project source or planning artifact
- N workspace memories across M episodes
- Verification result when available

Confidence: high | medium | low
Risk: low | medium | high
Status: verified | in-progress
```

For `Skill`, append:

```text
Trigger: observable condition
Steps:
1. Action
2. Action
Verification: observable success condition
```

## Quality Rules

- State one conclusion per card.
- Keep source-specific names when they are stable project facts; generalize one-off commands and temporary paths.
- Cite a few decisive evidence items, not the entire episode.
- Calibrate confidence from evidence agreement and verification, not writing fluency.
- Set risk high when an incorrect conclusion could cause destructive, security-sensitive, release, or data-integrity actions.
- Deduplicate against existing approved and pending project memories before presenting a new card.
- Keep low-confidence candidates visible only when they identify a useful unresolved question; never bulk approve them.
