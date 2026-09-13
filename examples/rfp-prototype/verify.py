#!/usr/bin/env python3
"""Execute real subprocesses and record their actual output and exit codes."""
import argparse
import json
import platform
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sample-out', default='sample-output')
    parser.add_argument('--report', default='test-results.json')
    args = parser.parse_args()
    commands = [
        [sys.executable, '-B', '-m', 'unittest', '-v', 'test_review'],
        [sys.executable, '-B', 'run_sample.py', '--out', args.sample_out]
    ]
    report_path = ROOT/args.report
    previous = json.loads(report_path.read_text()) if report_path.exists() else {}
    results = []
    for command in commands:
        start = time.monotonic()
        proc = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
        item = {'argv': command, 'cwd': str(ROOT), 'exit_code': proc.returncode,
                'elapsed_seconds': time.monotonic()-start, 'stdout': proc.stdout, 'stderr': proc.stderr}
        results.append(item)
        print('$ ' + ' '.join(command))
        print(proc.stdout, end='')
        print(proc.stderr, end='')
        print('exit_code=' + str(proc.returncode))
    report = {'recorded_at': datetime.now(timezone.utc).isoformat(), 'python_version': platform.python_version(),
              'evidence_type': 'automated software tests and synthetic sample',
              'all_commands_succeeded': all(x['exit_code'] == 0 for x in results),
              'benchmark_status': 'inconclusive', 'commands': results}
    if 'regression_before_fix' in previous:
        report['regression_before_fix'] = previous['regression_before_fix']
    (ROOT/args.report).write_text(json.dumps(report, indent=2) + '\n')
    return 0 if report['all_commands_succeeded'] else 1


if __name__ == '__main__':
    sys.exit(main())
