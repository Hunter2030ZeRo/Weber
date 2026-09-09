#!/usr/bin/env python3
# Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
import json
import os
import socket
import struct
import time

sock = socket.socket(fileno=3)
def exact(size):
    result = b''
    while len(result) < size:
        chunk = sock.recv(size - len(result))
        if not chunk:
            raise EOFError()
        result += chunk
    return result

try:
    while True:
        size, = struct.unpack('<I', exact(4))
        request = json.loads(exact(size))
        operation = request.get('method')
        if operation == 'close':
            break
        if operation == 'oversize':
            sock.sendall(struct.pack('<I', 65537))
            break
        if operation == 'delay':
            time.sleep(1)
        response = json.dumps({'id': request['id'], 'result': request.get('value')}).encode()
        sock.sendall(struct.pack('<I', len(response)) + response)
except (EOFError, BrokenPipeError, ConnectionResetError):
    pass
finally:
    sock.close()
