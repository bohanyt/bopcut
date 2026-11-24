// The worker waits for input before it can spawn the tool. The job owns the worker
// and every process it starts even if the original tool process exits first.
export const windowsWorker = String.raw`
	delete process.env.BOPENCUT_TOOL_WORKER;
	delete process.env.BOPENCUT_TOOL_EXECUTABLE;
	if (process.env.BOPENCUT_TOOL_BACKGROUND === "1") require("node:os").setPriority(0, 10);
	Promise.all([import("node:readline"), import("node:child_process")]).then(([{ createInterface }, { spawn }]) => {
		const input = createInterface({ input: process.stdin });
		input.once("line", (line) => {
			input.close();
			process.stdin.destroy();
			const [command, args] = JSON.parse(line);
			const tool = spawn(command, args, { windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
			tool.once("error", (error) => { console.error(error.message); process.exitCode = error.code === "ENOENT" ? 127 : 1; });
			tool.once("exit", (code) => { process.exitCode = code ?? 1; });
		});
	});
`;

export const windowsSupervisor = String.raw`
	$ErrorActionPreference = 'Stop'
	$ProgressPreference = 'SilentlyContinue'
	[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
	if ($env:BOPENCUT_TOOL_PLUGIN_FILE) {
		# POSIX mode bits are ignored on Windows. Protect scratch before creating the plugin or loading credentials.
		$directory = Get-Item -LiteralPath $env:TMPDIR -Force
		$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
		if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
			$directory.GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]) -ne $user) {
			throw 'The tool scratch directory is not owned by the current user.'
		}
		$security = [Security.AccessControl.DirectorySecurity]::new()
		$security.SetAccessRuleProtection($true, $false)
		$rule = [Security.AccessControl.FileSystemAccessRule]::new(
			$user, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
		$security.AddAccessRule($rule)
		$directory.SetAccessControl($security)
		$file = Join-Path $directory.FullName $env:BOPENCUT_TOOL_PLUGIN_FILE
		[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null
		[IO.File]::WriteAllText($file, $env:BOPENCUT_TOOL_PLUGIN_SOURCE)
		Remove-Item Env:BOPENCUT_TOOL_PLUGIN_FILE, Env:BOPENCUT_TOOL_PLUGIN_SOURCE
	}
	Add-Type -TypeDefinition @'
	using System;
	using System.ComponentModel;
	using System.Diagnostics;
	using System.IO;
	using System.Runtime.InteropServices;
	using System.Text;
	using System.Threading;

	public static class RetrievalJob {
		private const int BasicAccountingInformation = 1;
		private const int ExtendedLimitInformation = 9;
		private const uint KillOnJobClose = 0x2000;

		[StructLayout(LayoutKind.Sequential)]
		private struct BasicLimits {
			public long ProcessTime, JobTime;
			public uint Flags;
			public UIntPtr MinWorkingSet, MaxWorkingSet;
			public uint ActiveProcessLimit;
			public UIntPtr Affinity;
			public uint Priority, Scheduling;
		}

		[StructLayout(LayoutKind.Sequential)]
		private struct ExtendedLimits {
			public BasicLimits Basic;
			public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
			public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
		}

		[StructLayout(LayoutKind.Sequential)]
		private struct Accounting {
			public long User, Kernel, PeriodUser, PeriodKernel;
			public uint Faults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
		}

		[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
		private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
		[DllImport("kernel32.dll", SetLastError = true)]
		private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, int size);
		[DllImport("kernel32.dll", SetLastError = true)]
		private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
		[DllImport("kernel32.dll", SetLastError = true)]
		private static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, int size, IntPtr returned);
		[DllImport("kernel32.dll", SetLastError = true)]
		private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
		[DllImport("kernel32.dll")]
		private static extern bool CloseHandle(IntPtr handle);

		public static int Run(string executable) {
			string request = Console.ReadLine();
			if (request == null) return 1;
			var ownerClosed = new ManualResetEvent(false);
			var watchOwner = new Thread(() => {
				try { Console.Read(); }
				catch (IOException) { }
				finally { ownerClosed.Set(); }
			}) { IsBackground = true };
			watchOwner.Start();
			IntPtr job = CreateJobObject(IntPtr.Zero, null);
			if (job == IntPtr.Zero) throw new Win32Exception();
			try {
				var limits = new ExtendedLimits();
				limits.Basic.Flags = KillOnJobClose;
				if (Environment.GetEnvironmentVariable("BOPENCUT_TOOL_LOW_PRIORITY") == "1") {
					limits.Basic.Flags |= 0x20; // JOB_OBJECT_LIMIT_PRIORITY_CLASS
					limits.Basic.Priority = 0x4000; // BELOW_NORMAL_PRIORITY_CLASS
				}
				if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, Marshal.SizeOf(limits)))
					throw new Win32Exception();
				var start = new ProcessStartInfo(executable, "-e \"eval(process.env.BOPENCUT_TOOL_WORKER)\"") {
					UseShellExecute = false, RedirectStandardInput = true, CreateNoWindow = true,
				};
				using (var worker = new Process { StartInfo = start }) {
					worker.Start();
					if (!AssignProcessToJobObject(job, worker.Handle)) {
						var error = new Win32Exception();
						worker.StandardInput.Close(); // The assignment failed before any tool could start.
						worker.WaitForExit();
						throw error;
					}
					if (!ownerClosed.WaitOne(0)) {
						using (var input = new StreamWriter(worker.StandardInput.BaseStream, new UTF8Encoding(false), 1024, true))
							input.WriteLine(request);
					}
					worker.StandardInput.Close();
					bool stopping = false;
					for (;;) {
						Accounting accounting;
						if (!QueryInformationJobObject(job, BasicAccountingInformation, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
							throw new Win32Exception();
						if (accounting.ActiveProcesses == 0) break;
						if (stopping) Thread.Sleep(25);
						else if (ownerClosed.WaitOne(25)) {
							if (!TerminateJobObject(job, 1)) throw new Win32Exception();
							stopping = true;
						}
					}
					worker.WaitForExit();
					return worker.ExitCode;
				}
			} finally {
				CloseHandle(job);
			}
		}
	}
'@
	exit [RetrievalJob]::Run($env:BOPENCUT_TOOL_EXECUTABLE)
`;
