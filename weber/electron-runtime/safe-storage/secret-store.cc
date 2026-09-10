// Copyright Weber contributors. SPDX-License-Identifier: MIT
// Short-lived private-pipe helper. No Chromium, V8, persistent worker or polling.
#include <libsecret/secret.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/random.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <string>

int main(int argc, char** argv) {
  const pid_t parent = getppid();
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent || parent == 1) return 10;
  rlimit limit{0, 0};
  if (setrlimit(RLIMIT_CORE, &limit) || prctl(PR_SET_DUMPABLE, 0)) return 10;
  if (argc != 2 || !argv[1][0] || strlen(argv[1]) > 1024) return 10;
  // Serialize Weber's first-use creation across processes. Reject foreign or
  // symlinked lock paths. Electron does not participate in this advisory lock.
  const std::string directory = "/tmp/weber-safe-storage-" + std::to_string(getuid());
  if (mkdir(directory.c_str(), 0700) && errno != EEXIST) return 10;
  int dir = open(directory.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat st{};
  if (dir < 0 || fstat(dir, &st) || st.st_uid != getuid() || (st.st_mode & 0777) != 0700) return 10;
  int lock = openat(dir, "initialize", O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
  close(dir);
  if (lock < 0 || fstat(lock, &st) || !S_ISREG(st.st_mode) || st.st_uid != getuid() ||
      st.st_nlink != 1 || (st.st_mode & 0777) != 0600 || flock(lock, LOCK_EX)) return 10;

  SecretSchema schema{};
  schema.name = "chrome_libsecret_os_crypt_password_v2";
  schema.flags = SECRET_SCHEMA_DONT_MATCH_NAME;
  schema.attributes[0] = {"application", SECRET_SCHEMA_ATTRIBUTE_STRING};
  GError* error = nullptr;
  SecretService* service = secret_service_get_sync(SECRET_SERVICE_OPEN_SESSION, nullptr, &error);
  if (!service || error) return 13;
  GHashTable* attributes = secret_attributes_build(&schema, "application", argv[1], nullptr);
  GList* items = secret_service_search_sync(service, &schema, attributes,
      static_cast<SecretSearchFlags>(SECRET_SEARCH_ALL | SECRET_SEARCH_LOAD_SECRETS), nullptr, &error);
  if (error) return 13;
  if (items && items->next) return 12;  // Ambiguity must not rotate or overwrite keys.
  SecretValue* value = nullptr;
  gchar* generated = nullptr;
  const char* password = nullptr;
  if (items) {
    auto* item = SECRET_ITEM(items->data);
    if (secret_item_get_locked(item)) return 11;
    value = secret_item_get_secret(item);
    if (!value || !(password = secret_value_get_text(value))) return 13;
  } else {
    // Do not prompt, auto-unlock, or create a plaintext/file fallback. In
    // particular, a locked existing item must never look like a missing key.
    SecretCollection* collection = secret_collection_for_alias_sync(service,
        SECRET_COLLECTION_DEFAULT, SECRET_COLLECTION_NONE, nullptr, &error);
    if (!collection || error || secret_collection_get_locked(collection)) return 11;
    unsigned char random[16];
    if (getrandom(random, sizeof(random), 0) != static_cast<ssize_t>(sizeof(random))) return 13;
    generated = g_base64_encode(random, sizeof(random));
    explicit_bzero(random, sizeof(random));
    password = generated;
    if (!secret_password_store_sync(&schema, SECRET_COLLECTION_DEFAULT, "Chromium Safe Storage",
        password, nullptr, &error, "application", argv[1], nullptr) || error) return 13;
    g_object_unref(collection);
  }
  const size_t length = strlen(password);
  if (!length || length > 4096) return 13;
  const bool written = fwrite(password, 1, length, stdout) == length && fflush(stdout) == 0;
  if (generated) { explicit_bzero(generated, length); g_free(generated); }
  if (value) secret_value_unref(value);
  g_list_free_full(items, g_object_unref);
  g_hash_table_unref(attributes);
  g_object_unref(service);
  close(lock);
  return written ? 0 : 13;
}
