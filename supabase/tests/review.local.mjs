import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { Client } from "pg";
const db = new Client({
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
  ssl: false,
});
const A = randomUUID(),
  B = randomUUID(),
  owner = randomUUID(),
  viewer = randomUUID(),
  other = randomUUID();
const run = randomUUID(),
  comp = randomUUID(),
  a = randomUUID(),
  b = randomUUID();
const changed = randomUUID(),
  unpaired = randomUUID(),
  paired = randomUUID();
async function role(user, name = "authenticated") {
  await db.query(`set role ${name}`);
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: user }),
  ]);
}
async function rpc(name, args) {
  return (
    await db.query(
      `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) v`,
      args,
    )
  ).rows[0].v;
}
async function denied(sql, args, code = "42501") {
  await db.query("savepoint denied");
  try {
    await assert.rejects(db.query(sql, args), (e) => e.code === code);
  } finally {
    await db.query("rollback to denied; release savepoint denied");
  }
}
function check(name, fn) {
  test(name, async () => {
    await db.query("savepoint case_test");
    try {
      await fn();
    } finally {
      await db.query(
        "rollback to case_test; release savepoint case_test; reset role",
      );
    }
  });
}
before(async () => {
  await db.connect();
  await db.query("begin");
  await db.query("insert into auth.users(id) values($1),($2),($3)", [
    owner,
    viewer,
    other,
  ]);
  await db.query(
    "insert into public.tenants(id,name) values($1,'Review A'),($2,'Review B')",
    [A, B],
  );
  await db.query(
    "insert into public.tenant_memberships(tenant_id,user_id,role) values($1,$2,'owner'),($1,$3,'viewer'),($4,$5,'owner')",
    [A, owner, viewer, B, other],
  );
  for (const id of [a, b])
    await db.query(
      `insert into public.source_files(id,tenant_id,created_by,original_filename,
    expected_byte_count,status,byte_count,verified_mime,sha256,finalized_at)
    values($1,$2,$3,'file.csv',1,'ready',1,'text/csv',$4,now())`,
      [id, A, owner, "a".repeat(64)],
    );
  await db.query(
    "insert into public.comparisons(id,tenant_id,title,created_by) values($1,$2,'Review',$3)",
    [comp, A, owner],
  );
  await db.query(
    `insert into public.comparison_runs(id,tenant_id,comparison_id,current_file_id,incoming_file_id,
    configuration,status,result_count,result_digest) values($1,$2,$3,$4,$5,'{}','succeeded',3,'digest')`,
    [run, A, comp, a, b],
  );
  const product = {
    supplier_sku: "000001",
    description: "=cmd",
    cost_price: "1.2300",
    currency: "GBP",
  };
  for (const [id, outcome, old, next] of [
    [changed, "changed", product, { ...product, cost_price: "1.2301" }],
    [unpaired, "needs_review", null, product],
    [paired, "needs_review", product, product],
  ]) {
    await db.query(
      `insert into public.comparison_results(id,tenant_id,comparison_run_id,source_result_id,
      primary_outcome,review_state,change_flags,old_values,new_values,cost_delta,cost_delta_text,
      cost_change_percent,cost_change_percent_text,percentage_state,reasons,provenance)
      values($1,$2,$3,$1,$4,$5,'[]',$6,$7,$8::text::numeric,$8::text,$9::text::numeric,$9::text,$10,'[]','[]')`,
      [
        id,
        A,
        run,
        outcome,
        outcome === "changed" ? "not_required" : "pending",
        old,
        next,
        outcome === "changed" ? "0.0001" : null,
        outcome === "changed" ? "0.008130081300813008130081300813" : null,
        outcome === "changed" ? "defined" : "not_comparable",
      ],
    );
  }
});
after(async () => {
  await db.query("rollback");
  await db.end();
});
check(
  "result pagination uses a lookahead row without repeating page boundaries",
  async () => {
    await db.query("reset role");
    await db.query(
      `insert into public.comparison_results(id,tenant_id,comparison_run_id,source_result_id,
    primary_outcome,review_state,change_flags,old_values,new_values,cost_delta,cost_delta_text,
    percentage_state,reasons,provenance)
    select gen_random_uuid(),r.tenant_id,r.comparison_run_id,gen_random_uuid(),
      'changed','not_required',r.change_flags,
      jsonb_set(r.old_values,'{supplier_sku}',to_jsonb(lpad(n::text,8,'0'))),
      jsonb_set(r.new_values,'{supplier_sku}',to_jsonb(lpad(n::text,8,'0'))),
      r.cost_delta,r.cost_delta_text,'not_comparable',r.reasons,r.provenance
    from public.comparison_results r cross join generate_series(1,101) n where r.id=$1`,
      [changed],
    );
    await db.query(
      "update public.comparison_runs set result_count=104 where id=$1",
      [run],
    );
    await role(owner);
    const first = await rpc("csv_results_page", [A, run, "changed", "", 0]);
    const second = await rpc("csv_results_page", [A, run, "changed", "", 100]);
    assert.equal(first.length, 101);
    assert.equal(second.length, 2);
    const shown = new Set(first.slice(0, 100).map((r) => r.id));
    assert.ok(second.every((r) => !shown.has(r.id)));
    assert.equal(first[100].id, second[0].id);
  },
);
const resolve = (
  id,
  decision = "reject",
  note = "Excluded after checking evidence",
) => rpc("resolve_csv_review", [A, run, id, decision, note]);
check(
  "persisted counts expose pending review without browser invention",
  async () => {
    await role(owner);
    const s = await rpc("csv_run_summary", [A, run]);
    assert.equal(s.total, 3);
    assert.equal(s.outcomes.changed, 1);
    assert.equal(s.unresolved, 2);
  },
);
check(
  "server result filtering and string identifiers survive re-entry",
  async () => {
    await role(owner);
    const rows = await rpc("csv_results_page", [
      A,
      run,
      "changed",
      "000001",
      0,
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].new_values.supplier_sku, "000001");
    assert.equal(rows[0].cost_delta_text, "0.0001");
    assert.equal(
      (await rpc("csv_results_page", [A, run, "new", "", 0])).length,
      0,
    );
  },
);
check("unresolved review blocks export even through direct RPC", async () => {
  await role(owner);
  await denied("select public.csv_export_rows($1,$2)", [A, run], "23514");
});
check(
  "explicit no-match and rejection persist and release only deterministic changed rows",
  async () => {
    await role(owner);
    await resolve(unpaired, "no_match");
    await resolve(paired);
    const rows = await rpc("csv_export_rows", [A, run]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].supplier_sku, "000001");
    assert.equal(rows[0].new_cost, "1.2301");
    const s = await rpc("csv_run_summary", [A, run]);
    assert.equal(s.unresolved, 0);
    assert.equal(s.excluded, 2);
    assert.equal(s.outcomes.needs_review, 2);
  },
);
check(
  "same review decision is idempotent and conflicting decisions are rejected",
  async () => {
    await role(owner);
    const e = await resolve(unpaired);
    assert.equal((await resolve(unpaired)).id, e.id);
    await denied(
      "select public.resolve_csv_review($1,$2,$3,$4,$5)",
      [A, run, unpaired, "no_match", "Changed mind"],
      "23514",
    );
  },
);
check("unsafe accept and paired no-match are denied", async () => {
  await role(owner);
  for (const [id, decision] of [
    [unpaired, "accept"],
    [paired, "no_match"],
  ])
    await denied(
      "select public.resolve_csv_review($1,$2,$3,$4,$5)",
      [A, run, id, decision, "Reason"],
      "23514",
    );
});
check("non-review results and blank decision notes are denied", async () => {
  await role(owner);
  for (const [id, note] of [
    [changed, "Reason"],
    [unpaired, " "],
  ])
    await denied(
      "select public.resolve_csv_review($1,$2,$3,$4,$5)",
      [A, run, id, "reject", note],
      "23514",
    );
});
check("viewer cannot resolve review or mutate audit rows", async () => {
  await role(viewer);
  await denied("select public.resolve_csv_review($1,$2,$3,$4,$5)", [
    A,
    run,
    unpaired,
    "reject",
    "Reason",
  ]);
  await denied("delete from public.review_events where tenant_id=$1", [A]);
});
check(
  "browser cannot insert audit events or bypass worker output restrictions",
  async () => {
    await role(owner);
    await denied(
      "insert into public.review_events(tenant_id,comparison_run_id,comparison_result_id,actor_id,decision,note) values($1,$2,$3,$4,'reject','Reason')",
      [A, run, unpaired, owner],
    );
    await denied(
      "update public.comparison_results set review_state='not_required' where id=$1",
      [unpaired],
    );
  },
);
check("cross-tenant review and export references are rejected", async () => {
  await role(other);
  await denied("select public.resolve_csv_review($1,$2,$3,$4,$5)", [
    A,
    run,
    unpaired,
    "reject",
    "Reason",
  ]);
  await denied("select public.csv_export_rows($1,$2)", [A, run]);
  await denied("select public.resolve_csv_review($1,$2,$3,$4,$5)", [
    B,
    run,
    unpaired,
    "reject",
    "Reason",
  ]);
});
check(
  "tenant B cannot read tenant A evidence, counts or audit history",
  async () => {
    await role(owner);
    await resolve(unpaired);
    await role(other);
    assert.equal(
      (
        await db.query(
          "select * from public.review_events where tenant_id=$1",
          [A],
        )
      ).rows.length,
      0,
    );
    assert.equal(await rpc("csv_run_summary", [A, run]), null);
    assert.deepEqual(await rpc("csv_results_page", [A, run, "", "", 0]), []);
  },
);
check(
  "tenant-aware audit foreign key rejects cross-tenant result",
  async () => {
    await db.query("reset role");
    await denied(
      "insert into public.review_events(tenant_id,comparison_run_id,comparison_result_id,actor_id,decision,note) values($1,$2,$3,$4,'reject','Reason')",
      [B, run, unpaired, other],
      "23503",
    );
  },
);
check(
  "viewer may export resolved own-tenant deterministic results",
  async () => {
    await role(owner);
    await resolve(unpaired);
    await resolve(paired);
    await role(viewer);
    assert.equal((await rpc("csv_export_rows", [A, run])).length, 1);
  },
);
check("review cannot resolve a result from another run", async () => {
  await role(owner);
  await denied("select public.resolve_csv_review($1,$2,$3,$4,$5)", [
    A,
    randomUUID(),
    unpaired,
    "reject",
    "Reason",
  ]);
});
check("anonymous role cannot read or resolve review or export", async () => {
  await role(null, "anon");
  await denied("select * from public.review_events", []);
  await denied("select public.csv_export_rows($1,$2)", [A, run]);
});
