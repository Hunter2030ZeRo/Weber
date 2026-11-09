self.onmessage = async event => {
  let database;
  try {
    database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(event.data);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const record = await new Promise((resolve, reject) => {
      const request = database.transaction('files').objectStore('files').get('document');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    database.close(); database = undefined;
    self.postMessage({ origin: location.origin, record });
  } catch (error) { self.postMessage({ error: String(error) }); }
  finally { database?.close(); }
};
