// Temporary simulator-startup investigation; the Node caller sanitizes every name before egress.
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <time.h>

static mach_timebase_info_data_t timebase;

static uint64_t nanoseconds(uint64_t ticks) {
  return (uint64_t)((__uint128_t)ticks * timebase.numer / timebase.denom);
}

static uint64_t monotonic_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) {
    exit(1);
  }
  return (uint64_t)value.tv_sec * 1000 + (uint64_t)value.tv_nsec / 1000000;
}

static void wait_until(uint64_t deadline) {
  for (;;) {
    uint64_t now = monotonic_ms();
    if (now >= deadline) {
      return;
    }
    uint64_t remaining = deadline - now;
    struct timespec delay = {
        .tv_sec = (time_t)(remaining / 1000),
        .tv_nsec = (long)(remaining % 1000) * 1000000,
    };
    if (nanosleep(&delay, NULL) != 0 && errno != EINTR) {
      exit(1);
    }
  }
}

static int sample(unsigned int index, uint64_t started) {
  printf("BEGIN\t%u\t%" PRIu64 "\n", index, monotonic_ms() - started);
  fflush(stdout);

  // One bounded process-table query, with no executable-path or per-task inspection.
  size_t bytes = 16384 * sizeof(struct kinfo_proc);
  struct kinfo_proc *rows = malloc(bytes);
  if (rows == NULL) {
    return 1;
  }
  int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
  if (sysctl(mib, 4, rows, &bytes, NULL, 0) != 0) {
    free(rows);
    return 1;
  }
  size_t count = bytes / sizeof(*rows);
  for (size_t i = 0; i < count; i++) {
    const struct extern_proc *process = &rows[i].kp_proc;
    char name[sizeof(process->p_comm)];
    for (size_t j = 0; j < sizeof(name); j++) {
      char value = process->p_comm[j];
      // Keep process-controlled names within one TSV field; the caller owns role filtering.
      name[j] = value == '\t' || value == '\n' || value == '\r' ? '?' : value;
    }
    name[sizeof(name) - 1] = '\0';
    printf("CENSUS\t%d\t%d\t%jd\t%jd\t%s\n", process->p_pid,
           rows[i].kp_eproc.e_ppid, (intmax_t)process->p_starttime.tv_sec,
           (intmax_t)process->p_starttime.tv_usec, name);
    fflush(stdout);
  }

  for (size_t i = 0; i < count; i++) {
    pid_t pid = rows[i].kp_proc.p_pid;
    // The marker preserves the blocked PID if the external deadline ends this observation.
    printf("QUERY\t%d\n", pid);
    fflush(stdout);
    struct proc_taskinfo info;
    if (proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &info, sizeof(info)) == sizeof(info)) {
      printf("TASK\t%d\t%" PRIu64 "\t%" PRIu64 "\t%" PRId32 "\t%" PRId32 "\n", pid,
             nanoseconds(info.pti_total_user), nanoseconds(info.pti_total_system),
             info.pti_threadnum, info.pti_numrunning);
      fflush(stdout);
    }
  }
  free(rows);
  printf("END\t%u\t%" PRIu64 "\n", index, monotonic_ms() - started);
  fflush(stdout);
  return 0;
}

int main(void) {
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || timebase.denom == 0) {
    return 1;
  }
  const uint64_t offsets_ms[] = {0, 5000, 20000, 45000};
  uint64_t started = monotonic_ms();
  for (unsigned int i = 0; i < sizeof(offsets_ms) / sizeof(offsets_ms[0]); i++) {
    wait_until(started + offsets_ms[i]);
    if (sample(i, started) != 0) {
      return 1;
    }
  }
  return 0;
}
