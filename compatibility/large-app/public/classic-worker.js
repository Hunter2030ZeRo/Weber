self.onmessage = event => {
  if (event.data?.port) {
    const port = event.data.port;
    port.onmessage = message => port.postMessage(message.data);
    port.start();
  } else self.postMessage(event.data);
};
