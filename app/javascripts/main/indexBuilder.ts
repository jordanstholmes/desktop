import '../../@types/modules';
import index from '../../index.html';

export function buildIndexFile({
  hostName,
  baseUrl,
}: {
  hostName: string;
  baseUrl: string;
}): string {
  return index
    .replace('{{EXT_SERVER_HOST_NAME}}', hostName)
    .replace(/\{\{BASE_URL\}\}/g, baseUrl);
}
