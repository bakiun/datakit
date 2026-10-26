import type { TestApi } from '../../src/extension';
import type { DataSourceNode } from '../../src/explorer/nodes';

/** The data sources the tree lists, from all environment folders. */
export async function listedDataSources(api: TestApi): Promise<DataSourceNode[]> {
  const folders = await api.tree.getChildren();
  const children = await Promise.all(folders.map((folder) => api.tree.getChildren(folder)));
  return children.flat().filter((n): n is DataSourceNode => n.kind === 'dataSource');
}
