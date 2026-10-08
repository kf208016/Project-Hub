// Read only the CurrentDirectory field of native x64 process parameters.
// PID + creation time are checked on the same handle before any memory read.
// No debug privilege, thread changes, process termination, or memory dump.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

class HubProcessCwd {
  const uint QUERY_INFORMATION = 0x0400, VM_READ = 0x0010, SYNCHRONIZE = 0x00100000;
  const uint WAIT_TIMEOUT = 258;
  const int MAX_BATCH = 128, MAX_INPUT = 65536;
  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint low, high; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_BASIC_INFORMATION {
    public IntPtr reserved1, peb, reserved2a, reserved2b, pid, reserved3;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct OS_VERSION {
    public uint size, major, minor, build, platform;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string servicePack;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsWow64Process2(IntPtr process, out ushort machine, out ushort nativeMachine);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr length, out UIntPtr read);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, out PROCESS_BASIC_INFORMATION info, int length, out int returned);
  [DllImport("ntdll.dll", CharSet=CharSet.Unicode)] static extern int RtlGetVersion(ref OS_VERSION version);

  static readonly Regex UTC = new Regex(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$");
  static readonly Regex RESERVED = new Regex(@"^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)", RegexOptions.IgnoreCase);
  static readonly Encoding UTF16 = new UnicodeEncoding(false, false, true);
  static bool layoutConfirmed;
  static Dictionary<string, object> Result(int pid, string creation, string cwd, string status) {
    return new Dictionary<string, object> {{"pid",pid},{"creationTime",creation},{"cwd",cwd},{"status",status}};
  }
  static bool Pointer(long p, int length) { return p >= 65536 && length >= 0 && p <= 0x00007fffffffffffL - length; }
  static byte[] Read(IntPtr process, long address, int length) {
    if (!Pointer(address, length)) throw new InvalidOperationException("unsupported-layout");
    byte[] data = new byte[length]; UIntPtr read;
    if (!ReadProcessMemory(process, new IntPtr(address), data, new UIntPtr((uint)length), out read) || read.ToUInt64() != (ulong)length)
      throw new InvalidOperationException("read-failed");
    return data;
  }
  static long Creation(IntPtr process) {
    FILETIME creation, exit, kernel, user;
    if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) throw new InvalidOperationException("read-failed");
    return (long)(((ulong)creation.high << 32) | creation.low);
  }
  static bool Supported(IntPtr process) {
    if (IntPtr.Size != 8) return false;
    ushort machine, nativeMachine;
    if (!IsWow64Process2(process, out machine, out nativeMachine) || machine != 0 || nativeMachine != 0x8664) return false;
    OS_VERSION v = new OS_VERSION(); v.size = (uint)Marshal.SizeOf(typeof(OS_VERSION));
    // CurrentDirectory is an internal layout. Future OS builds require review;
    // structural checks alone are not permission to guess a new layout.
    return RtlGetVersion(ref v) == 0 && v.major == 10 && v.minor == 0 && v.build >= 19041 && v.build <= 26200;
  }
  static long Parameters(IntPtr process) {
    PROCESS_BASIC_INFORMATION info; int returned;
    int size = Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION));
    if (NtQueryInformationProcess(process, 0, out info, size, out returned) != 0 || returned != size || !Pointer(info.peb.ToInt64(), 0x28))
      throw new InvalidOperationException("unsupported-layout");
    // Native AMD64 PEB.ProcessParameters, not the WOW64 PEB.
    long pointer = BitConverter.ToInt64(Read(process, info.peb.ToInt64() + 0x20, 8), 0);
    if (!Pointer(pointer, 0x50) || (pointer & 7) != 0) throw new InvalidOperationException("unsupported-layout");
    return pointer;
  }
  static byte[] Cwd(IntPtr process, long parameters, out byte[] header, out byte[] descriptor) {
    header = Read(process, parameters, 12);
    uint maximum = BitConverter.ToUInt32(header, 0), length = BitConverter.ToUInt32(header, 4), flags = BitConverter.ToUInt32(header, 8);
    if (length < 0x50 || maximum < length || maximum > 1024 * 1024 || (flags & 1) != 1)
      throw new InvalidOperationException("unsupported-layout");
    // RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath on native AMD64.
    // Only the descriptor and its bounded UTF-16 string are read.
    descriptor = Read(process, parameters + 0x38, 16);
    int bytes = BitConverter.ToUInt16(descriptor, 0), capacity = BitConverter.ToUInt16(descriptor, 2);
    long pointer = BitConverter.ToInt64(descriptor, 8);
    if (bytes < 6 || (bytes & 1) != 0 || capacity < bytes || (capacity & 1) != 0 || !Pointer(pointer, bytes) || (pointer & 1) != 0)
      throw new InvalidOperationException("unsupported-layout");
    return Read(process, pointer, bytes);
  }
  static bool Equal(byte[] a, byte[] b) {
    if (a.Length != b.Length) return false;
    for (int i=0; i<a.Length; i++) if (a[i] != b[i]) return false;
    return true;
  }
  static bool LocalPath(string value) {
    if (value.Length < 3 || value.Length > 32767 || !Regex.IsMatch(value, @"^[A-Za-z]:\\")) return false;
    string[] parts = value.Substring(3).Split('\\');
    for (int i=0; i<parts.Length; i++) {
      string part = parts[i];
      if (part == "" && i == parts.Length - 1) continue;
      if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ") || RESERVED.IsMatch(part)) return false;
      foreach(char c in part) if (c < 32 || c == 127 || "<>\"|?*:/".IndexOf(c) >= 0) return false;
    }
    return true;
  }
  static bool ConfirmLayout() {
    // Calibrate the selected OS/architecture layout against the helper's own
    // documented current-directory API before reading another process.
    try {
      IntPtr process = GetCurrentProcess();
      if (!Supported(process)) return false;
      long parameters = Parameters(process);
      byte[] header, descriptor;
      string value = UTF16.GetString(Cwd(process, parameters, out header, out descriptor));
      return LocalPath(value) && value.TrimEnd('\\').Equals(Environment.CurrentDirectory.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
    } catch { return false; }
  }
  static Dictionary<string, object> Query(Dictionary<string, object> request) {
    int pid = request.ContainsKey("pid") && request["pid"] is int ? (int)request["pid"] : 0;
    string expectedText = request.ContainsKey("since") ? request["since"] as string : null;
    DateTime expected;
    if (request.Count != 2 || pid <= 0 || expectedText == null || !UTC.IsMatch(expectedText) ||
        !DateTime.TryParseExact(expectedText, "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out expected))
      return Result(pid, "", "", "invalid-request");
    IntPtr process = OpenProcess(QUERY_INFORMATION | VM_READ | SYNCHRONIZE, false, (uint)pid);
    if (process == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      return Result(pid, "", "", error == 5 ? "access-denied" : error == 87 ? "not-found" : "read-failed");
    }
    string creationText = "";
    try {
      long creation = Creation(process);
      DateTime actual = DateTime.FromFileTimeUtc(creation);
      creationText = actual.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);
      // CIM DATETIME preserves microseconds, while FILETIME has 100 ns ticks.
      // Compare exactly at CIM precision, never at JavaScript millisecond precision.
      if (actual.Ticks / 10 != expected.Ticks / 10) return Result(pid, creationText, "", "pid-reused");
      if (WaitForSingleObject(process, 0) != WAIT_TIMEOUT) return Result(pid, creationText, "", "not-found");
      if (!layoutConfirmed || !Supported(process)) return Result(pid, creationText, "", "unsupported-layout");
      long parameters = Parameters(process);
      byte[] header, descriptor, nextHeader, nextDescriptor;
      byte[] cwd = Cwd(process, parameters, out header, out descriptor);
      byte[] nextCwd = Cwd(process, parameters, out nextHeader, out nextDescriptor);
      if (Parameters(process) != parameters || !Equal(header,nextHeader) || !Equal(descriptor,nextDescriptor) || !Equal(cwd,nextCwd) || Creation(process) != creation)
        return Result(pid, creationText, "", "changed");
      if (WaitForSingleObject(process, 0) != WAIT_TIMEOUT) return Result(pid, creationText, "", "not-found");
      string value = UTF16.GetString(cwd);
      if (!LocalPath(value)) return Result(pid, creationText, "", "invalid-path");
      return Result(pid, creationText, value, "ok");
    } catch (EntryPointNotFoundException) { return Result(pid, creationText, "", "unsupported-layout"); }
      catch (DllNotFoundException) { return Result(pid, creationText, "", "unsupported-layout"); }
      catch (DecoderFallbackException) { return Result(pid, creationText, "", "invalid-path"); }
      catch (InvalidOperationException e) { return Result(pid, creationText, "", e.Message); }
      catch { return Result(pid, creationText, "", "read-failed"); }
    finally { CloseHandle(process); }
  }
  static int Main() {
    try {
      Console.InputEncoding = new UTF8Encoding(false, true);
      Console.OutputEncoding = new UTF8Encoding(false, true);
      StringBuilder input = new StringBuilder(); int next;
      while ((next = Console.In.Read()) >= 0) {
        if (input.Length >= MAX_INPUT) return 2;
        input.Append((char)next);
      }
      JavaScriptSerializer json = new JavaScriptSerializer(); json.MaxJsonLength = 16 * 1024 * 1024;
      object raw = json.DeserializeObject(input.ToString());
      object[] requests = raw as object[];
      if (requests == null || requests.Length > MAX_BATCH) return 2;
      layoutConfirmed = ConfirmLayout();
      List<Dictionary<string, object>> result = new List<Dictionary<string, object>>(); HashSet<int> seen = new HashSet<int>();
      foreach(object item in requests) {
        Dictionary<string, object> request = item as Dictionary<string, object>;
        if (request == null || !request.ContainsKey("pid") || !(request["pid"] is int) || !seen.Add((int)request["pid"])) return 2;
        result.Add(Query(request));
      }
      Console.Out.WriteLine(json.Serialize(result));
      return 0;
    } catch { return 2; }
  }
}
