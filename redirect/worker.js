// The page moved: theaipipe.com/demos/overnight-selection-room/* answers 301 to the same path under
// theaipipe.com/demos/overnight-caskets-own-name/.
const OLD = '/demos/overnight-selection-room';
const NEW = '/demos/overnight-caskets-own-name';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const rest = url.pathname.startsWith(OLD) ? url.pathname.slice(OLD.length) : '';
    return new Response(null, {
      status: 301,
      headers: { Location: `${url.origin}${NEW}${rest || '/'}${url.search}`, 'X-Robots-Tag': 'noindex, nofollow' },
    });
  },
};
