# RFP review prototype

A working, dependency-free Python CLI produced by founder-001's Astra coding workshop. It extracts draft requirements from text documents, cites source lines, tracks explicit amendments, flags conflicting Q&A, and scores results against a frozen reference.

The managed session generated and tested the code but stalled before publishing its artifact bundle. This copy was recovered from recorded source-writing commands and the agent's recorded fixes, reviewed, then tested locally. It is **not** a downloaded hosted artifact. See [the trial and recovery record](../../docs/trials/astra-build-001.md).

## Run from the repository root

Requires Python 3.9 or later; no packages or credentials.

```sh
python3 -B -m unittest discover -s examples/rfp-prototype -p 'test_*.py' -v
python3 -B examples/rfp-prototype/run_sample.py --out /tmp/my-rfp-sample
```

Choose a new output directory for each sample run. Existing outputs are deliberately preserved.

For your own text package, copy and edit `samples/package.json` and its document files, then run:

```sh
python3 -B examples/rfp-prototype/rfp_review.py generate path/to/package.json --out /tmp/my-rfp-review
```

The manifest must distinguish synthetic fixtures from primary sources. Primary sources require verification metadata and pre-recorded content hashes; these are operator attestations, not independent verification by the software. Input is UTF-8 text, with form feeds for page boundaries. PDF, OCR, and table extraction are not implemented.

## What was observed

- All 26 software tests passed again after source recovery.
- The synthetic sample emitted 11 checklist rows, preserving a superseded deadline and flagging conflicting submission instructions.
- The scoring step recovered 8/10 reference obligations and 6/8 critical obligations. The recall gates failed; correction time was unmeasured.
- No real three-package benchmark, customer trial, launch, or willingness-to-pay test was performed.

Inspect [the generated checklist](sample-output-v2/candidate/checklist.md), [score](sample-output-v2/score.json), and [local verification record](recovery-test-results.json). These outputs were regenerated locally from the recovered code. Their timestamps and hashes belong to that local run.

The parser uses simple line and heading heuristics. A passing software test means its specified behavior worked; it does not establish reliable extraction of arbitrary procurement requirements.
