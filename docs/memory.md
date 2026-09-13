# Memory and the public studio

## Principle

The artist's career is durable data owned by this project. A model session is a working context, not the only copy of its history. Replacing a model, moving hosting, or losing a session must not erase the artist.

## Implemented record layers

1. **Identity:** versioned JSON dossier, retained by content hash and snapshotted per cycle. Identity-change suggestions remain proposals; they do not mutate the dossier.
2. **Observations:** supplied sources, studio notes, and explicit fixtures. Each has a date, original ID, stream, visibility, and source URL when external.
3. **Working history:** proposals, maker specifications, rendered artifact references, criticism, and artist decisions. Each stage/revision has its own checkpoint.
4. **Reflections:** learnings and unresolved questions generated after a cycle, including abstention and rejection.
5. **Operational events:** a hash-linked event log describing claims, completions, failures, and pauses. It contains no raw model reasoning or provider error payloads.

Memory entries have stable IDs, a kind, content, source IDs, optional cycle linkage, visibility, and an optional `supersedes` reference. The application inserts records rather than overwriting them. Corrections retain the original entry and add a new one.

SQLite is the authoritative local store. FTS5 supplies a derived search index. Artifact specifications, PNGs, and SVGs live in content-addressed directories. An artifact manifest includes hashes of all three representations.

## Retrieval

A new cycle snapshots:

- The current artist profile.
- Up to six recent completed public cycles, including their outcomes and reflections.
- Up to eight relevant public memory entries from full-text search against the artist's interests and observation titles.

Superseded entries remain searchable and public but are omitted from active retrieved context. Private material is not carried into later public cycles. The current cycle's private observations are still available to its roles, and its derived outputs are private.

Snapshots make it possible to inspect which memories a particular decision had available. They also prevent the context silently changing in the middle of a resumed job.

This first implementation has bounded lexical retrieval, not semantic embeddings, an autonomous memory-consolidation process, or full graph traversal. A long career will need ranking across themes, direct work relationships, older unresolved questions, and a diversity allocation so recent work does not monopolize recall. An embedding index should be rebuildable from the canonical records.

## Public archive

`studio export` creates a portable immutable snapshot containing:

- Public cycle records and their source observations.
- Public identity, role instructions, explicit outputs, decisions, and reflections.
- Artifact files from completed render stages, including experiments that were rejected or revised.
- Local-release manifests.
- Operational event metadata and the hash-chain verification result.
- A JSONL memory export for reuse outside the application.

Private-source cycles and derived content are omitted. Global operational metadata can indicate that a cycle existed without exposing its content. The number of withheld memories is disclosed. Raw database files and provider traces are not public artifacts.

The public archive is local until a publishing adapter uploads it. Its snapshot hash detects changes relative to that snapshot; the local event chain is not independent proof against an administrator rewriting the entire database. Publishing snapshot hashes externally is a future provenance improvement.

All model-authored material in an export is an explicit output requested by the studio. It is not a transcript of hidden reasoning. A rejected idea can be part of the public practice without inventing access to a model's private internal process.

## Next memory milestones

- Public read-only archive and search API, plus the journal/catalog interface.
- Cloudflare-backed canonical records and R2 artifact storage.
- Provider session/turn IDs and reconciled managed-job records linked to the existing cycle IDs.
- Public source references with rights-aware excerpts and provenance metadata.
- Structured relationships: responds-to, revises, contradicts, develops, abandons.
- Retrieval evaluations that test older memory, conflict handling, and source attribution.
- Explicit periodic consolidation into versioned themes and open questions, preserving original entries.
- Portable archive import with ID conflict checks and artifact verification.

Do not let a vendor's automatic compaction become the only surviving account of what the artist has done.
