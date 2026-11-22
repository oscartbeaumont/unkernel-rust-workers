// The guest init for the Worker's minimal initrd.
//
// The base unkernel initramfs boots a busybox userland, an overlay and a shell
// on the console; a Worker that only serves HTTP from one binary needs none of
// that. This init mounts the file systems, brings loopback up, runs the
// terminal server (kwtty: the SDK reaches the guest's processes and TCP
// sockets through it) and reaps whatever exits.
//
// The guest binary is started by the SDK through kwtty (vm.spawn), not here:
// the SDK waits for kwtty anyway, so spawning it from init would just race it.

#define _GNU_SOURCE
#include <errno.h>
#include <net/if.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static void mount_one(const char *src, const char *tgt, const char *type, unsigned long flags, const char *data) {
    mkdir(tgt, 0755);
    /* A missing file system is not fatal: nothing here is needed to run. */
    if (mount(src, tgt, type, flags, data) != 0)
        fprintf(stderr, "kw-init: mount %s: %s\n", tgt, strerror(errno));
}

/* The guest server binds 127.0.0.1, so loopback has to be up. */
static void loopback_up(void) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return;
    struct ifreq ifr;
    memset(&ifr, 0, sizeof ifr);
    strcpy(ifr.ifr_name, "lo");
    if (ioctl(fd, SIOCGIFFLAGS, &ifr) == 0) {
        ifr.ifr_flags |= IFF_UP | IFF_RUNNING;
        if (ioctl(fd, SIOCSIFFLAGS, &ifr) != 0)
            fprintf(stderr, "kw-init: lo up: %s\n", strerror(errno));
    }
    close(fd);
}

/* kwtty is the SDK's way into the guest: exec and TCP over vsock. */
static pid_t start_kwtty(void) {
    pid_t pid = fork();
    if (pid == 0) {
        execl("/usr/bin/kwtty", "kwtty", "serve", (char *)NULL);
        fprintf(stderr, "kw-init: kwtty: %s\n", strerror(errno));
        _exit(127);
    }
    return pid;
}

int main(void) {
    setenv("PATH", "/run/kw/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", 1);

    mount_one("devtmpfs", "/dev", "devtmpfs", 0, "");
    mount_one("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, "");
    mount_one("sysfs", "/sys", "sysfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, "");
    mount_one("tmpfs", "/run", "tmpfs", MS_NOSUID | MS_NODEV, "mode=755");
    mount_one("tmpfs", "/tmp", "tmpfs", MS_NOSUID | MS_NODEV, "mode=1777");

    loopback_up();

    pid_t kwtty = start_kwtty();
    for (;;) {
        int status;
        pid_t pid = waitpid(-1, &status, 0);
        if (pid < 0) {
            /* Nothing left to reap: wait for a change instead of spinning. */
            usleep(100000);
            continue;
        }
        if (pid == kwtty) {
            /* kwtty died: bring it back (the SDK rejects while it is gone). */
            usleep(100000);
            kwtty = start_kwtty();
        }
    }
}
