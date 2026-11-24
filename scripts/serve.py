"""Local preview of site/ on 127.0.0.1 only: python3 scripts/serve.py 8813 site"""
import functools, http.server, sys
class S(http.server.ThreadingHTTPServer):
    request_queue_size = 128
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[2])
h.func.log_message = lambda *a: None
S(('127.0.0.1', int(sys.argv[1])), h).serve_forever()
