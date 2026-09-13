# Recovered prototype build

Source origin: OpenAI managed coding session for studio cycle `6d389293-dbd0-47ff-b83e-5713af7c6330`, job `4a06715e-0703-41c2-bee9-0ea38c85a8dd`.

The agent created Python source and fixtures, ran an initial 25-test suite, added a failing explicit-waiver regression, fixed it, and reran 26 tests successfully. Its command output records those actions. Numeric process exit codes in API command metadata were null; subprocess output recorded explicit codes.

The remote turn remained in progress after its final report. No immutable artifacts were available through the artifact endpoint. The studio requested cancellation at its ten-minute deadline. This local copy was reconstructed from literal heredoc contents in command records and the subsequent recorded string edits. No captured shell command was executed on the host during recovery.

The recovered Python source was reviewed, then executed with an empty inherited environment using the system Python interpreter. The verification program reran all 26 tests and the sample's three subprocesses successfully. See `recovery-test-results.json` for actual local command output and exit codes.

Local sample output is regenerated evidence, not the missing original hosted bundle. It confirms 80% overall and 75% critical recall on the authored synthetic fixture; both recall gates fail. The real-world benchmark remains inconclusive.
