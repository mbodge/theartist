#!/usr/bin/env python3
"""Offline RFP review assistant. Documents are data; no commands or URLs are executed."""
import argparse
import csv
import hashlib
import io
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

VERSION = '0.1.1'
GATES = {'critical_recall': 1.0, 'overall_recall': 0.95,
         'invented_mandatory': 0, 'citation_errors': 0, 'correction_minutes': 30}
MAX_BYTES = 2_000_000


def canonical(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()


def digest(obj):
    return hashlib.sha256(canonical(obj)).hexdigest()


def read_json(path):
    p = Path(path)
    if p.stat().st_size > MAX_BYTES:
        raise ValueError('JSON input exceeds 2 MB')
    return json.loads(p.read_text(encoding='utf-8'))


def write_json(path, obj):
    Path(path).write_text(json.dumps(obj, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def seal(obj):
    return dict(obj, artifact_sha256=digest(obj))


def verify_seal(obj):
    body = {k: v for k, v in obj.items() if k != 'artifact_sha256'}
    if obj.get('artifact_sha256') != digest(body):
        raise ValueError('Artifact hash mismatch: frozen artifact was modified')


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def load_package(manifest_path):
    p = Path(manifest_path).resolve()
    manifest = read_json(p)
    if manifest.get('evidence_type') not in ('synthetic', 'primary'):
        raise ValueError('evidence_type must be synthetic or primary')
    if not manifest.get('package_id') or not isinstance(manifest.get('documents'), list):
        raise ValueError('package_id and documents are required')
    if manifest['evidence_type'] == 'primary':
        evidence = manifest.get('verification', {})
        required = ('official_listing_url', 'closure_evidence', 'retrieved_at',
                    'completeness_rationale', 'verified_by')
        if not all(evidence.get(k) for k in required):
            raise ValueError('Primary package lacks recorded source/closure verification')
    snapshots = []
    ids = set()
    for doc in manifest['documents']:
        for key in ('id', 'path', 'version', 'date', 'kind', 'authority_verified'):
            if key not in doc:
                raise ValueError('Document missing ' + key)
        if not isinstance(doc['authority_verified'], bool):
            raise ValueError('authority_verified must be boolean')
        if doc['id'] in ids:
            raise ValueError('Duplicate document ID')
        ids.add(doc['id'])
        if doc['kind'] not in ('original', 'amendment', 'qa'):
            raise ValueError('Unsupported document kind')
        datetime.strptime(doc['date'], '%Y-%m-%d')
        source = (p.parent / doc['path']).resolve()
        if not source.is_relative_to(p.parent):
            raise ValueError('Source path must remain inside the manifest directory')
        if source.suffix.lower() != '.txt':
            raise ValueError('Only UTF-8 .txt sources are supported; preserve PDF page breaks as form feeds')
        content = source.read_bytes()
        if len(content) > MAX_BYTES:
            raise ValueError('Source exceeds 2 MB')
        source_hash = hashlib.sha256(content).hexdigest()
        if manifest['evidence_type'] == 'primary' and not doc.get('sha256'):
            raise ValueError('Primary sources require pre-recorded SHA-256 hashes')
        if doc.get('sha256') and doc['sha256'] != source_hash:
            raise ValueError('Source hash mismatch for ' + doc['id'])
        snapshots.append(dict(doc, text=content.decode('utf-8'), sha256=source_hash))
    if sum(len(d['text'].encode()) for d in snapshots) > MAX_BYTES:
        raise ValueError('Package exceeds 2 MB')
    if not any(d['kind'] == 'original' for d in snapshots):
        raise ValueError('Package needs an original solicitation')
    if not any(d['kind'] in ('amendment', 'qa') for d in snapshots):
        raise ValueError('Package needs an amendment or Q&A')
    return manifest, snapshots


MANDATORY = re.compile(r'\b(must|shall|required|mandatory)\b|\b(?:proposals?|responses?|bids?)\s+(?:are\s+)?due\b', re.I)
ADVISORY = re.compile(r'\b(should|recommended|encouraged|may)\b', re.I)
HEADING = re.compile(r'^Section\s+([\w.-]+)\.\s+(.+?)(?:\s+\(replaces\s+([\w.-]+)\s+section\s+([\w.-]+)\))?$', re.I)


def classify(text):
    low = text.lower()
    if re.search(r'\b(acknowledge|acknowledgment|acknowledgement)\b', low):
        return 'amendment_acknowledgment'
    if re.search(r'\b(disqualified|disqualification|rejected|ineligible)\b', low):
        return 'disqualification'
    if re.search(r'\b(deadline|due|no later than)\b|\bby\s+\d{4}-\d{2}-\d{2}', low):
        return 'deadline'
    if re.search(r'\b(eligible|eligibility|licensed|registered)\b', low):
        return 'eligibility'
    if re.search(r'\b(submit|submission|include|attach|upload|deliver)\b', low):
        return 'submission'
    return None


def generate(manifest, docs):
    start = time.monotonic()
    rows, warnings, replacements = [], [], []
    for doc in sorted(docs, key=lambda d: (d['date'], d['id'])):
        section, section_title, heading_citation = None, None, None
        for page_num, page in enumerate(doc['text'].split('\f'), 1):
            for line_num, line in enumerate(page.splitlines(), 1):
                text = line.strip()
                if not text:
                    continue
                cite = {'document_id': doc['id'], 'source_file': doc['path'],
                        'source_version': doc['version'], 'source_sha256': doc['sha256'],
                        'page': page_num, 'line': line_num, 'section': section, 'excerpt': text}
                heading = HEADING.match(text)
                if heading:
                    section, section_title, target_doc, target_section = heading.groups()
                    cite['section'] = section
                    heading_citation = cite
                    if target_doc:
                        replacements.append({'document_id': doc['id'], 'section': section,
                                             'target_document': target_doc, 'target_section': target_section,
                                             'citation': cite})
                    continue
                if not MANDATORY.search(text) and not ADVISORY.search(text):
                    continue
                # Remove explicit waiver phrases only for strength classification; keep the full source wording.
                strength_text = re.sub(r'\bnot\s+(?:be\s+)?(?:required|mandatory)\b', '', text, flags=re.I)
                status = 'mandatory' if MANDATORY.search(strength_text) else 'advisory'
                ambiguity = []
                if text.count(';') or len(re.findall(r'\b(?:must|shall)\b', text, re.I)) > 1:
                    ambiguity.append('May contain multiple obligations; human atomization required')
                if section is None:
                    ambiguity.append('No recognized section heading')
                row = {'package_id': manifest['package_id'], 'requirement_id': f'R{len(rows)+1:03}',
                       'obligation': text, 'status': status,
                       'critical_category': classify(text) if status == 'mandatory' else None,
                       'condition': text.split(',')[0] if re.match(r'^(if|when|unless)\b', text, re.I) else None,
                       'section_title': section_title, 'citations': [cite],
                       'lifecycle': 'active', 'supersedes': [], 'superseded_by': [],
                       'change_citations': [], 'unresolved_ambiguity': ambiguity}
                # Deduplicate only literal obligations within a section; keep every supporting citation.
                prior = next((r for r in rows if r['obligation'] == text and
                              r['citations'][0]['section'] == section and
                              r['citations'][0]['document_id'] == doc['id']), None)
                if prior:
                    prior['citations'].append(cite)
                else:
                    rows.append(row)
    by_id = {d['id']: d for d in docs}
    for change in replacements:
        newer = by_id[change['document_id']]
        older = by_id.get(change['target_document'])
        new_rows = [r for r in rows if r['citations'][0]['document_id'] == newer['id'] and
                    r['citations'][0]['section'] == change['section']]
        old_rows = [r for r in rows if r['citations'][0]['document_id'] == change['target_document'] and
                    r['citations'][0]['section'] == change['target_section']]
        valid = (older and newer['kind'] == 'amendment' and newer['authority_verified'] and
                 older['date'] < newer['date'] and new_rows and old_rows)
        if not valid:
            warnings.append('Unresolved replacement: ' + change['citation']['excerpt'])
            for row in new_rows:
                row['unresolved_ambiguity'].append('Replacement authority, chronology, or target unresolved')
                row['lifecycle'] = 'unresolved'
            continue
        for old in old_rows:
            old['lifecycle'] = 'superseded'
            old['superseded_by'] += [r['requirement_id'] for r in new_rows]
        for new in new_rows:
            new['supersedes'] += [r['requirement_id'] for r in old_rows]
            new['change_citations'].append(change['citation'])
    # Same-section differing assertions across documents require review absent an explicit replacement.
    for i, row in enumerate(rows):
        if row['lifecycle'] == 'superseded':
            continue
        for other in rows[i+1:]:
            a, b = row['citations'][0], other['citations'][0]
            if (other['lifecycle'] != 'superseded' and a['section'] is not None and
                a['section'] == b['section'] and a['document_id'] != b['document_id'] and
                row['obligation'] != other['obligation']):
                for r in (row, other):
                    r['lifecycle'] = 'unresolved'
                    msg = 'Different assertions in the same section across sources; authority needs review'
                    if msg not in r['unresolved_ambiguity']:
                        r['unresolved_ambiguity'].append(msg)
    return seal({'schema_version': 1, 'workflow_version': VERSION,
                 'workflow_source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                 'generated_at': utc_now(),
                 'evidence_type': manifest['evidence_type'], 'package_id': manifest['package_id'],
                 'manifest_sha256': digest(manifest), 'manifest': manifest, 'source_snapshots': docs,
                 'generation_seconds': time.monotonic()-start, 'rows': rows, 'warnings': warnings,
                 'extraction_limitations': 'Heuristic line extraction; implicit duties, tables, OCR, paraphrases and semantic change reconciliation require human review.'})


def valid_citation(cite, raw):
    doc = next((d for d in raw['source_snapshots'] if d['id'] == cite.get('document_id')), None)
    if not doc or cite.get('source_sha256') != doc['sha256']:
        return False
    if hashlib.sha256(doc['text'].encode()).hexdigest() != doc['sha256']:
        return False
    if cite.get('source_file') != doc['path'] or cite.get('source_version') != doc['version']:
        return False
    try:
        if type(cite['page']) is not int or type(cite['line']) is not int or min(cite['page'], cite['line']) < 1:
            return False
        line = doc['text'].split('\f')[cite['page']-1].splitlines()[cite['line']-1].strip()
        return bool(cite['excerpt']) and line == cite['excerpt']
    except (IndexError, KeyError, TypeError):
        return False


def freeze_reference(path, output):
    ref = read_json(path)
    if not ref.get('package_id') or ref.get('evidence_type') not in ('synthetic', 'primary'):
        raise ValueError('Reference needs package_id and evidence_type')
    ids = set()
    for row in ref['requirements']:
        if row['id'] in ids or not row.get('obligation') or type(row.get('applicable')) is not bool:
            raise ValueError('Invalid or duplicate reference obligation')
        if row.get('critical_category') not in (None, 'eligibility', 'submission', 'deadline', 'disqualification', 'amendment_acknowledgment'):
            raise ValueError('Unknown critical category')
        ids.add(row['id'])
    if Path(output).exists():
        raise ValueError('Refusing to overwrite frozen reference')
    write_json(output, seal(dict(ref, frozen_at=utc_now())))


def review_template(raw):
    return {'evidence_type': raw['evidence_type'], 'candidate_sha256': raw['artifact_sha256'],
            'reference_sha256': None, 'reviewer': None, 'review_basis': None,
            'correction_minutes': None, 'reference_disputes': [],
            'rows': [{'candidate_id': r['requirement_id'], 'matches': [], 'supported': None,
                      'citation_correct': None, 'notes': ''} for r in raw['rows']]}


def score(raw, ref, review):
    verify_seal(raw)
    verify_seal(ref)
    if raw['package_id'] != ref['package_id'] or raw['evidence_type'] != ref['evidence_type']:
        raise ValueError('Candidate and reference packages/evidence types differ')
    if review.get('evidence_type') != raw['evidence_type']:
        raise ValueError('Review evidence type differs')
    if review.get('candidate_sha256') != raw['artifact_sha256'] or review.get('reference_sha256') != ref['artifact_sha256']:
        raise ValueError('Review must bind the exact frozen candidate and reference hashes')
    if not review.get('reviewer') or not review.get('review_basis'):
        raise ValueError('Reviewer and review_basis are required')
    if ref['frozen_at'] > raw['generated_at']:
        raise ValueError('Reference must be frozen before candidate generation')
    candidate = {r['requirement_id']: r for r in raw['rows']}
    refs = {r['id']: r for r in ref['requirements'] if r['applicable']}
    judgments = review.get('rows', [])
    if len(judgments) != len(candidate) or {r['candidate_id'] for r in judgments} != set(candidate):
        raise ValueError('Review must inspect every candidate row exactly once')
    matched, invented, citation_errors = set(), [], []
    for judgment in judgments:
        row = candidate[judgment['candidate_id']]
        if type(judgment.get('supported')) is not bool or type(judgment.get('citation_correct')) is not bool:
            raise ValueError('Every row needs explicit support and semantic citation judgments')
        if not isinstance(judgment.get('matches'), list) or not set(judgment['matches']).issubset(refs):
            raise ValueError('Matches must name applicable reference IDs')
        citation_ok = (judgment['citation_correct'] and bool(row['citations']) and
                       all(valid_citation(c, raw) for c in row['citations'] + row['change_citations']))
        # All presented rows are inspected, including historical rows. Errors cannot be hidden by selection.
        if not citation_ok:
            citation_errors.append(row['requirement_id'])
        if row['status'] == 'mandatory' and not judgment['supported']:
            invented.append(row['requirement_id'])
        if row['lifecycle'] == 'active' and judgment['supported']:
            matched.update(judgment['matches'])
    critical = {key for key, r in refs.items() if r['critical_category']}
    overall = len(matched)/len(refs) if refs else None
    critical_recall = len(matched & critical)/len(critical) if critical else None
    minutes = review.get('correction_minutes')
    if minutes is not None and (type(minutes) not in (int, float) or not 0 <= minutes < float('inf')):
        raise ValueError('correction_minutes must be finite and nonnegative or null')
    gates = {'critical_recall': None if critical_recall is None else critical_recall == 1,
             'overall_recall': None if overall is None else overall >= .95,
             'no_invented_mandatory': not invented, 'all_citations_correct': not citation_errors,
             'correction_time': None if minutes is None else minutes <= 30}
    failed = any(v is False for v in gates.values())
    incomplete = not refs or minutes is None or bool(review.get('reference_disputes'))
    result = 'fail' if failed else ('inconclusive' if incomplete else 'pass')
    return {'schema_version': 1, 'package_id': raw['package_id'], 'evidence_type': raw['evidence_type'],
            'candidate_sha256': raw['artifact_sha256'], 'reference_sha256': ref['artifact_sha256'],
            'review_sha256': digest(review), 'reference_total': len(refs), 'matched_total': len(matched),
            'critical_total': len(critical), 'critical_matched': len(matched & critical),
            'overall_recall': overall, 'critical_recall': critical_recall,
            'missed_obligations': sorted(set(refs)-matched), 'invented_mandatory': invented,
            'citation_errors': citation_errors, 'correction_minutes': minutes,
            'reference_disputes': review.get('reference_disputes', []), 'gates': gates,
            'package_gate_result': result, 'benchmark_eligible': raw['evidence_type'] == 'primary',
            'benchmark_status': 'inconclusive',
            'benchmark_note': 'A single package or synthetic fixture cannot establish the three-package benchmark.'}


def export_candidate(raw, output):
    out = Path(output)
    if out.exists():
        raise ValueError('Output directory exists; refusing to replace preserved candidate artifacts')
    out.mkdir(parents=True)
    write_json(out/'raw.json', raw)
    write_json(out/'review-template.json', review_template(raw))
    columns = ['package_id', 'requirement_id', 'obligation', 'status', 'critical_category',
               'condition', 'lifecycle', 'citations', 'supersedes', 'superseded_by', 'change_citations', 'unresolved_ambiguity']
    with (out/'checklist.csv').open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        for row in raw['rows']:
            # Neutralize spreadsheet formulas without modifying the preserved raw assertion.
            values = {k: json.dumps(row[k], ensure_ascii=False) if isinstance(row[k], list) else row[k] for k in columns}
            for k, value in values.items():
                if isinstance(value, str) and value.startswith(('=', '+', '-', '@', '\t', '\r')):
                    values[k] = "'" + value
            writer.writerow(values)
    lines = [f"# {raw['package_id']} — {raw['evidence_type'].upper()} input", '',
             'Heuristic draft. Every row needs human source and condition review.', '']
    for row in raw['rows']:
        # Literal code blocks keep untrusted source content out of rendered links/HTML.
        quote = row['obligation'].replace('`', '\\`')
        lines += [f"- **{row['requirement_id']}** ({row['status']}; {row['lifecycle']}; {row['critical_category'] or 'noncritical'})", '']
        lines += ['    ' + line for line in quote.splitlines()]
        lines += ['']
        for cite in row['citations']:
            lines += [f"    Source: {cite['document_id']} v{cite['source_version']}, page {cite['page']}, line {cite['line']}, section {cite['section']}."]
        if row['supersedes']:
            lines += ['    Supersedes: ' + ', '.join(row['supersedes'])]
        if row['unresolved_ambiguity']:
            lines += ['    Review: ' + '; '.join(row['unresolved_ambiguity'])]
        lines += ['']
    (out/'checklist.md').write_text('\n'.join(lines), encoding='utf-8')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('generate', help='Read a package manifest; no reference input is accepted')
    p.add_argument('manifest'); p.add_argument('--out', required=True)
    p = sub.add_parser('freeze-reference')
    p.add_argument('reference'); p.add_argument('--out', required=True)
    p = sub.add_parser('score')
    p.add_argument('--candidate', required=True); p.add_argument('--reference', required=True)
    p.add_argument('--review', required=True); p.add_argument('--out', required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == 'generate':
            manifest, docs = load_package(args.manifest)
            raw = generate(manifest, docs)
            export_candidate(raw, args.out)
            print(json.dumps({'package_id': raw['package_id'], 'rows': len(raw['rows']),
                              'evidence_type': raw['evidence_type'], 'artifact_sha256': raw['artifact_sha256']}))
        elif args.command == 'freeze-reference':
            freeze_reference(args.reference, args.out)
            print('Frozen reference: ' + args.out)
        else:
            if Path(args.out).exists():
                raise ValueError('Refusing to overwrite score output')
            result = score(read_json(args.candidate), read_json(args.reference), read_json(args.review))
            write_json(args.out, result)
            print(json.dumps(result, indent=2))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print('error: ' + str(exc), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
