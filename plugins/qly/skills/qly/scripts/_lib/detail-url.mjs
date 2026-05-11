// Build a qlydata (千里眼 / "qly") internal detail URL from a haohuo product URL.
//
// Input:  https://haohuo.jinritemai.com/.../index.html?id=<ID>&origin_type=604
// Output: https://qlydata.com/#/market_rank/goods/goods_search/goods_detail?pId=<ID>
//
// The ID inside `id=<...>` of the haohuo URL maps 1:1 to qlydata's `pId`,
// confirmed by inspecting the qly search result table's data-row-key
// attribute (the suffix after the dash matches both fields).

const QLY_DETAIL_URL_PREFIX = 'https://qlydata.com/#/market_rank/goods/goods_search/goods_detail?pId=';

export function extractProductId(productUrl) {
  if (typeof productUrl !== 'string' || productUrl.length === 0) return null;
  const m = productUrl.match(/[?&]id=(\d+)/);
  return m ? m[1] : null;
}

export function buildQlyDetailUrl(productUrl) {
  const id = extractProductId(productUrl);
  return id ? QLY_DETAIL_URL_PREFIX + id : null;
}
