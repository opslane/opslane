# Loss ledger (W4.M)

The program's success metric is user-impact conversion: the share of affected
users on open incidents whose incident carries a receipt. Each new run appends
the date, runner, and raw output verbatim. The query lives in
`scripts/loss-ledger.sql`.

## 2026-08-10 — baseline (pre-program)

Source: the receipts design measurement
(`docs/design/2026-08-10-actionable-receipts.md` §1), taken before
`digest_readiness` existed. It found 163 open error groups and about 118
affected users; 9 groups reached a PR, touching 2 users. The design prose says
“~7% conversion by issue count,” while 9/163 is 5.5%; the raw counts below
govern. User-impact conversion was about 2% (2/118 = 1.7%).

Raw record (reconstructed into the script's row grammar from the design
measurement; this is not runner output because the script postdates the
baseline):

```text
ord | section      | k1               | k2              | n_groups | n_users | pct
1   | totals_error | receipt_groups:9 | receipt_users:2 | 163      | 118     | 1.7
```
