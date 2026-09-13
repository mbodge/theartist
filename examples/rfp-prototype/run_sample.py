#!/usr/bin/env python3
"""Run labelled fixture through separate freeze, generation and scoring subprocesses."""
import argparse
import json
import subprocess
import sys
from pathlib import Path
import rfp_review as rfp

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default='sample-output')
    args = parser.parse_args()
    out = Path(args.out).resolve()
    if out.exists():
        print('Refusing to overwrite sample run', file=sys.stderr)
        return 2
    out.mkdir(parents=True)
    runs = []
    def run(parts):
        command = [sys.executable, '-B', str(ROOT/'rfp_review.py'), *map(str, parts)]
        proc = subprocess.run(command, text=True, capture_output=True, cwd=ROOT)
        runs.append({'argv': command, 'exit_code': proc.returncode, 'stdout': proc.stdout, 'stderr': proc.stderr})
        rfp.write_json(out/'commands.json', runs)
        print('$ ' + ' '.join(command))
        print(proc.stdout, end='')
        print(proc.stderr, end='', file=sys.stderr)
        if proc.returncode:
            raise RuntimeError('Sample subprocess failed')
    run(['freeze-reference', ROOT/'samples/reference.json', '--out', out/'reference.frozen.json'])
    run(['generate', ROOT/'samples/package.json', '--out', out/'candidate'])
    # Fixture adjudication occurs only AFTER raw generation. These are declared synthetic labels,
    # not a semantic model or a human correction-time measurement.
    raw = rfp.read_json(out/'candidate/raw.json')
    ref = rfp.read_json(out/'reference.frozen.json')
    review = rfp.review_template(raw)
    review.update(reference_sha256=ref['artifact_sha256'], reviewer='SYNTHETIC fixture adjudicator',
                  review_basis='Authored synthetic expected mappings; no independent review',
                  correction_minutes=None)
    mapping = {'registered': 'F1', '2025-02-05': 'F2', 'fixed-price': 'F3',
               "subcontractor's role": 'F4', 'procurement portal': 'F5',
               'accessibility': 'F6', 'Late proposals': 'F7', 'acknowledge': 'F9', 'screenshots': 'F10'}
    for judgment, row in zip(review['rows'], raw['rows']):
        judgment.update(supported=True, citation_correct=True,
                        matches=[v for k, v in mapping.items() if k in row['obligation']],
                        notes='Synthetic fixture mapping; citation support asserted only for this authored fixture')
    rfp.write_json(out/'review.synthetic.json', review)
    run(['score', '--candidate', out/'candidate/raw.json', '--reference', out/'reference.frozen.json',
         '--review', out/'review.synthetic.json', '--out', out/'score.json'])
    score = rfp.read_json(out/'score.json')
    assert score['reference_total'] == 10 and score['matched_total'] == 8, score
    assert score['critical_matched'] == 6 and score['critical_total'] == 8, score
    assert score['package_gate_result'] == 'fail', score
    assert score['benchmark_status'] == 'inconclusive' and not score['benchmark_eligible']
    assert len([x for x in raw['rows'] if x['lifecycle'] == 'superseded']) == 1
    assert len([x for x in raw['rows'] if x['lifecycle'] == 'unresolved']) == 2
    print('Synthetic sample assertions passed; benchmark remains inconclusive.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
