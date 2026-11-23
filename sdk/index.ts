// SPDX-License-Identifier: MIT
// The specialized host runtime this Worker boots: createKernel(), the
// kernel handle, and the protocol layers copied unchanged from unkernel's
// js/core (vsock, kwtty, HTTP/1.1, console output, WASI).
//
// worker/kernel.ts binds it to the platform (the bundled, build-time
// compiled kernel module); worker/index.ts uses spawn/connect/fetch.

export { createKernelOn, KernelInstance } from "./instance.ts";
export type { CreateKernelOptions, InstanceStats, Platform } from "./instance.ts";
export { Kernel, bundledBoot, moduleIsMemory64 } from "./kernel.ts";
export type { BootStage, ExitKind, ExitResult, KernelConfig, KernelStats, MemoryStage } from "./kernel.ts";
export { VSOCK_GUEST_CID, VSOCK_HOST_CID, VsockHost } from "./vsock.ts";
export type { Vsock, VsockConnection, VsockStats } from "./vsock.ts";
export { TTY_PORT, attachPty, connectGuest, execSubprocess, spawnPty, spawnSubprocess } from "./tty.ts";
export type { ConnectOptions, ExecOptions, ExecResult, GuestSocket, PipeOptions, Pty, PtyOptions, Subprocess } from "./tty.ts";
export { fetchOver } from "./http.ts";
export type { ByteDuplex, GuestConnect } from "./http.ts";
export { ConsoleOutput, errorText } from "./output.ts";
export { WasiHost } from "./wasi.ts";
