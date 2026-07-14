export interface OpItem {
  id: string;
  name: string;
  path: string;
  method?: string;
  httpPath?: string;
}

export interface ApiTreeNode {
  name: string;
  folders: ApiTreeNode[];
  operations: OpItem[];
}

interface OpInput {
  id: string;
  name: string;
  path: string;
  http?: { method: string; path: string };
}

function getOrCreateChild(node: ApiTreeNode, name: string): ApiTreeNode {
  let child = node.folders.find((f) => f.name === name);
  if (!child) {
    child = { name, folders: [], operations: [] };
    node.folders.push(child);
  }
  return child;
}

function sortTree(node: ApiTreeNode): void {
  node.folders.sort((a, b) => a.name.localeCompare(b.name));
  node.operations.sort((a, b) => a.name.localeCompare(b.name));
  for (const folder of node.folders) {
    sortTree(folder);
  }
}

export function buildApiTree(ops: OpInput[]): ApiTreeNode[] {
  const apis = new Map<string, ApiTreeNode>();

  for (const op of ops) {
    const segments = op.path.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    const [apiName, ...rest] = segments;
    const folderSegments = rest.slice(0, -1);

    let api = apis.get(apiName);
    if (!api) {
      api = { name: apiName, folders: [], operations: [] };
      apis.set(apiName, api);
    }

    let node = api;
    for (const segment of folderSegments) {
      node = getOrCreateChild(node, segment);
    }

    const item: OpItem = {
      id: op.id,
      name: op.name,
      path: op.path,
      method: op.http?.method,
      httpPath: op.http?.path,
    };
    node.operations.push(item);
  }

  const tree = Array.from(apis.values());
  tree.forEach(sortTree);
  tree.sort((a, b) => a.name.localeCompare(b.name));
  return tree;
}

/** Flatten an API tree into every API/folder path (e.g. 'default', 'billing', 'billing/charges'). */
export function flattenLocations(tree: ApiTreeNode[]): string[] {
  const paths: string[] = [];
  const walk = (node: ApiTreeNode, prefix: string) => {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    paths.push(path);
    for (const folder of node.folders) walk(folder, path);
  };
  for (const api of tree) walk(api, '');
  return paths;
}
