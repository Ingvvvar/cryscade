// Объекты кучи по снимку V8 (§13, фаза 9): сумма собственных размеров узлов, достижимых сильными рёбрами от корней
// сборщика, кроме внутренних списков V8 — «(Strong root list)» (кэши движка: smi_string_cache и др.) и «(Internalized
// strings)», — без кода (тип code: машинный код JIT, байткод, векторы обратной связи) и без нативных объектов Blink.
// Так куча — то, что держит программа: код, который JIT дописывает между 50-м и 300-м спином по мере прогрева, и кэши
// движка, которые растут рывками вместе с кучей, — не объекты игры (проба прогона №3: снимки страницы и воркера).

interface Snapshot {
  readonly snapshot: { readonly meta: { readonly node_fields: string[]; readonly node_types: [string[]]; readonly edge_fields: string[]; readonly edge_types: [string[]] } };
  readonly nodes: number[];
  readonly edges: number[];
  readonly strings: string[];
}

const INTERNAL_ROOTS = new Set(['(Strong root list)', '(Internalized strings)']);
const NOT_OBJECTS = new Set(['code', 'native', 'synthetic']);

export function heapObjectBytes(json: string): number {
  const snapshot = JSON.parse(json) as Snapshot;
  const { meta } = snapshot.snapshot;
  const nodeFields = meta.node_fields.length;
  const edgeFields = meta.edge_fields.length;
  const [nodeTypes] = meta.node_types;
  const [edgeTypes] = meta.edge_types;
  const typeAt = meta.node_fields.indexOf('type');
  const nameAt = meta.node_fields.indexOf('name');
  const sizeAt = meta.node_fields.indexOf('self_size');
  const edgeCountAt = meta.node_fields.indexOf('edge_count');
  const edgeTypeAt = meta.edge_fields.indexOf('type');
  const toAt = meta.edge_fields.indexOf('to_node');
  const { nodes, edges, strings } = snapshot;
  const count = nodes.length / nodeFields;
  const first = new Uint32Array(count + 1);
  for (let node = 0, edge = 0; node < count; node++) {
    first[node] = edge;
    edge += (nodes[node * nodeFields + edgeCountAt] ?? 0) * edgeFields;
    first[node + 1] = edge;
  }
  const name = (node: number): string => strings[nodes[node * nodeFields + nameAt] ?? 0] ?? '';
  const children = (node: number): number[] => {
    const out: number[] = [];
    for (let edge = first[node] ?? 0; edge < (first[node + 1] ?? 0); edge += edgeFields) {
      if (edgeTypes[edges[edge + edgeTypeAt] ?? 0] === 'weak') continue;
      out.push((edges[edge + toAt] ?? 0) / nodeFields);
    }
    return out;
  };
  // Узел 0 — корень снимка; у «(GC roots)» дети — списки корней, внутренние списки движка пропускаются.
  const start = children(0).flatMap((root) => (name(root) === '(GC roots)' ? children(root).filter((list) => !INTERNAL_ROOTS.has(name(list))) : [root]));
  const seen = new Uint8Array(count);
  const stack = [...start];
  for (const node of stack) seen[node] = 1;
  let bytes = 0;
  while (stack.length > 0) {
    const node = stack.pop() ?? 0;
    if (!NOT_OBJECTS.has(nodeTypes[nodes[node * nodeFields + typeAt] ?? 0] ?? '')) bytes += nodes[node * nodeFields + sizeAt] ?? 0;
    for (const child of children(node)) {
      if (seen[child] === 1) continue;
      seen[child] = 1;
      stack.push(child);
    }
  }
  return bytes;
}
