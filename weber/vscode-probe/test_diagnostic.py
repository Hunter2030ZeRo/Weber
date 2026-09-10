import sys
import tempfile
import unittest
from pathlib import Path
import run as probe


class DiagnosticTest(unittest.TestCase):
    def test_source_strings_are_not_exceptions(self):
        source = 'function f(){return " Error: misleading embedded string";}'
        error, stack = probe.extract_exception(source + '\nTypeError: actual failure\n    at main (app.js:1:2)\n', '')
        self.assertEqual(error, 'TypeError: actual failure')
        self.assertEqual(stack, ['at main (app.js:1:2)'])

    def test_vscode_timestamped_exception_is_not_lost(self):
        prefix = '[main 2026-09-10T12:17:52.108Z]'
        source = 'const text = "' + prefix + ' TypeError: embedded";'
        error, stack = probe.extract_exception(source + '\n\x1b[91m' + prefix + '\x1b[0m TypeError: session method missing\n    at configureSession (main.js:561:4589)\n', '')
        self.assertEqual(error, 'TypeError: session method missing')
        self.assertEqual(stack, ['at configureSession (main.js:561:4589)'])

    def test_error_codes_and_ansi(self):
        error, stack = probe.extract_exception('\x1b[31mError [ERR_MODULE_NOT_FOUND]: missing module\x1b[0m\n', '')
        self.assertEqual(error, 'Error [ERR_MODULE_NOT_FOUND]: missing module')
        self.assertEqual(stack, [])

    def test_real_process_large_source_tail(self):
        script = "import sys; sys.stderr.write('x'*300000 + ' Error: embedded in source\\nTypeError: real failure\\n    at test (app.js:2:3)\\n'); sys.exit(1)"
        with tempfile.TemporaryDirectory() as directory:
            result = probe.startup([sys.executable, '-c', script], Path(directory), Path(directory), 5)
        self.assertEqual(result['error'], 'TypeError: real failure')
        self.assertEqual(result['stack'], ['at test (app.js:2:3)'])
        self.assertEqual(result['exit_code'], 1)
        self.assertFalse(result['timed_out'])
