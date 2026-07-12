// A consumer project as Emberflow sees it: their own nodes, their own flows,
// scenarios as reviewable sidecar files. This directory is both an example
// and the repo's daily project-mode dev target (npm run dev:project).
export default {
  flowsDir: 'flows',
  registerNodes(registry) {
    registry.register(
      {
        type: 'TriageOrder',
        label: 'Triage Order',
        description: 'Demo consumer node: classifies an order by value and flags rush shipping.',
        category: 'demo',
        inputSchema: {
          fields: [
            { name: 'total', type: 'number', required: true },
            { name: 'express', type: 'boolean' },
          ],
        },
        outputSchema: {
          fields: [
            { name: 'tier', type: 'enum', enumValues: ['standard', 'priority', 'vip'] },
            { name: 'rush', type: 'boolean' },
          ],
        },
      },
      async (ctx) => {
        const total = Number(ctx.input.total);
        const tier = total >= 500 ? 'vip' : total >= 100 ? 'priority' : 'standard';
        const rush = Boolean(ctx.input.express) && tier !== 'standard';
        ctx.log('info', `Order ${total} → ${tier}${rush ? ' (rush)' : ''}`);
        return { tier, rush };
      },
    );
  },
};
