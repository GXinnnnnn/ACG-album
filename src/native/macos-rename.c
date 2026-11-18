/* SPDX-License-Identifier: MIT
 * Atomic same-directory rename without replacement. Built only on macOS.
 * argv: source destination file|directory source-identity parent-identity
 * Identity: f|d:dev:ino:birthtime-nanoseconds (the journal's BigIntStats values).
 * No shell, recursive traversal, copying, deletion, or fallback rename is used.
 */
#ifndef __APPLE__
#error "acg-fs-rename requires macOS renameatx_np(RENAME_EXCL)"
#endif
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static const char *error_code(int value) {
  switch (value) {
    case EEXIST: return "EEXIST";
    case ENOENT: return "ENOENT";
    case ENOTDIR: return "ENOTDIR";
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case ELOOP: return "ELOOP";
    case EXDEV: return "EXDEV";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ENOTEMPTY: return "ENOTEMPTY";
    case EINVAL: return "EINVAL";
    case ENOSPC: return "ENOSPC";
    case EROFS: return "EROFS";
    case ESTALE: return "ESTALE";
    default: return "EIO";
  }
}
static int fail(int value, const char *stage) {
  printf("{\"ok\":false,\"errno\":%d,\"code\":\"%s\",\"stage\":\"%s\"}\n",
         value, error_code(value), stage);
  return 1;
}
static int basename_valid(const char *name) {
  const size_t length = strlen(name);
  if (!length || length > 255 || !strcmp(name, ".") || !strcmp(name, "..")) return 0;
  for (size_t i = 0; i < length; i++) {
    const unsigned char c = (unsigned char)name[i];
    if (c == '/' || c < 32 || c == 127) return 0;
  }
  return 1;
}
static int identity_matches(const struct stat *stat, const char *expected, char kind) {
  if ((kind == 'd' && !S_ISDIR(stat->st_mode)) ||
      (kind == 'f' && !S_ISREG(stat->st_mode)) ||
      stat->st_ino == 0 || stat->st_birthtimespec.tv_sec < 0 ||
      stat->st_birthtimespec.tv_nsec < 0 || stat->st_birthtimespec.tv_nsec >= 1000000000L)
    return 0;
  const uint64_t born = (uint64_t)stat->st_birthtimespec.tv_sec * UINT64_C(1000000000) +
                        (uint64_t)stat->st_birthtimespec.tv_nsec;
  if (born == 0) return 0;
  char actual[160];
  const int count = snprintf(actual, sizeof(actual), "%c:%" PRIu64 ":%" PRIu64 ":%" PRIu64,
                             kind, (uint64_t)stat->st_dev, (uint64_t)stat->st_ino, born);
  return count > 0 && (size_t)count < sizeof(actual) && !strcmp(actual, expected);
}
/* Pin each directory from / with O_NOFOLLOW so neither an ancestor symlink nor
 * an ancestor replacement can redirect the final rename to a different folder. */
static int open_parent(const char *parent) {
  int directory = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory < 0) return -1;
  if (!strcmp(parent, "/")) return directory;
  char *copy = strdup(parent + 1);
  if (!copy) { close(directory); errno = ENOMEM; return -1; }
  char *remaining = copy, *component;
  while ((component = strsep(&remaining, "/")) != NULL) {
    if (!*component || !strcmp(component, ".") || !strcmp(component, "..")) {
      free(copy); close(directory); errno = EINVAL; return -1;
    }
    const int next = openat(directory, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    const int saved = errno;
    close(directory);
    if (next < 0) { free(copy); errno = saved; return -1; }
    directory = next;
  }
  free(copy);
  return directory;
}
int main(int argc, char **argv) {
  if (argc != 6 || argv[1][0] != '/' || argv[2][0] != '/') return fail(EINVAL, "arguments");
  const char *old_name = strrchr(argv[1], '/'), *new_name = strrchr(argv[2], '/');
  if (!old_name || !new_name || !basename_valid(old_name + 1) || !basename_valid(new_name + 1))
    return fail(EINVAL, "name");
  const size_t old_length = (size_t)(old_name - argv[1]), new_length = (size_t)(new_name - argv[2]);
  if (old_length != new_length || memcmp(argv[1], argv[2], old_length)) return fail(EXDEV, "parent");
  const char kind = !strcmp(argv[3], "file") ? 'f' : !strcmp(argv[3], "directory") ? 'd' : 0;
  if (!kind || strlen(argv[4]) > 159 || strlen(argv[5]) > 159) return fail(EINVAL, "identity");
  char *parent = old_length ? strndup(argv[1], old_length) : strdup("/");
  if (!parent) return fail(ENOMEM, "parent");
  const int directory = open_parent(parent);
  const int open_error = errno;
  free(parent);
  if (directory < 0) return fail(open_error, "open-parent");
  struct stat parent_stat, source_stat;
  if (fstat(directory, &parent_stat) < 0) {
    const int saved = errno; close(directory); return fail(saved, "parent-stat");
  }
  if (!identity_matches(&parent_stat, argv[5], 'd')) {
    close(directory); return fail(ESTALE, "parent-identity");
  }
  if (fstatat(directory, old_name + 1, &source_stat, AT_SYMLINK_NOFOLLOW) < 0) {
    const int saved = errno; close(directory); return fail(saved, "source-stat");
  }
  if (!identity_matches(&source_stat, argv[4], kind)) {
    close(directory); return fail(ESTALE, "source-identity");
  }
  if (renameatx_np(directory, old_name + 1, directory, new_name + 1, RENAME_EXCL) < 0) {
    const int saved = errno; close(directory); return fail(saved, "rename");
  }
  close(directory);
  puts("{\"ok\":true}");
  return 0;
}
