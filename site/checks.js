// The cross-tenant check, shared by the page and tests/rls.test.mjs.
// Each query runs signed in as one person of home A (role authenticated, user id in the
// token claims, as Supabase Auth sets them) and asks for home B's rows.

export function crossTenantChecks(A, B) {
  const director = A.users.find((u) => u.label === 'Director');
  const arranger = A.users.find((u) => u.label === 'Arranger');
  return [
    { id: 'control', user: director, question: `${A.short} reads its own arrangements`,
      sql: 'select count(*)::int as n from arrangements', params: [],
      pass: (r) => r.rows && r.rows[0].n >= 1, answer: (r) => `${r.rows[0].n} ${r.rows[0].n === 1 ? 'row' : 'rows'}` },
    { id: 'control_costs', user: director, question: `${A.short} reads its own saved costs`,
      sql: 'select count(*)::int as n from arrangement_line_costs', params: [],
      pass: (r) => r.rows && r.rows[0].n >= 1, answer: (r) => `${r.rows[0].n} ${r.rows[0].n === 1 ? 'row' : 'rows'}` },
    { id: 'read', user: director, question: `${A.short} reads ${B.short}'s arrangements`,
      sql: 'select count(*)::int as n from arrangements where org_id = $1', params: [B.id],
      pass: (r) => r.rows && r.rows[0].n === 0, answer: (r) => `${r.rows[0].n} rows` },
    { id: 'update', user: director, question: `${A.short} changes ${B.short}'s arrangements`,
      sql: "update arrangements set family_label = 'changed' where org_id = $1 returning id", params: [B.id],
      pass: (r) => r.rows && r.rows.length === 0, answer: (r) => `${r.rows.length} rows changed` },
    { id: 'insert', user: director, question: `${A.short} files an arrangement under ${B.short}`,
      sql: "insert into arrangements (org_id, family_label) values ($1, 'filed by the other home')", params: [B.id],
      pass: (r) => !!r.error && /row-level security/i.test(r.error), answer: (r) => (r.error ? "refused: " + r.error : `${r.affected} rows written`) },
    { id: 'rules', user: director, question: `${A.short} reads ${B.short}'s pricing rules`,
      sql: 'select count(*)::int as n from pricing_rules where org_id = $1', params: [B.id],
      pass: (r) => r.rows && r.rows[0].n === 0, answer: (r) => `${r.rows[0].n} rows` },
    { id: 'costs', user: director, question: `${A.short} reads ${B.short}'s saved costs`,
      sql: 'select count(*)::int as n from arrangement_line_costs where org_id = $1', params: [B.id],
      pass: (r) => r.rows && r.rows[0].n === 0, answer: (r) => `${r.rows[0].n} rows` },
    { id: 'arranger_rules', user: arranger, question: `${A.short}'s arranger changes a pricing rule of ${A.short}`,
      sql: 'update pricing_rules set markup_value = 0 where org_id = $1 returning id', params: [A.id],
      pass: (r) => r.rows && r.rows.length === 0, answer: (r) => `${r.rows.length} rows changed` },
    { id: 'arranger_costs', user: arranger, question: `${A.short}'s arranger reads ${A.short}'s saved costs`,
      sql: 'select count(*)::int as n from arrangement_line_costs where org_id = $1', params: [A.id],
      pass: (r) => r.rows && r.rows[0].n === 0, answer: (r) => `${r.rows[0].n} rows` },
  ];
}

// What B holds, counted by the service role (which bypasses row level security), so that
// "0 rows" above cannot be an empty table.
export const OWNER_COUNT = 'select count(*)::int as n from arrangements where org_id = $1';
