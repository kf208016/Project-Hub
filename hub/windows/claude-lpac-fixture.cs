// Trusted W0 synthetic fixture; .NET Framework, mscorlib + System only.
// No CLI, auth/profile access, arbitrary path/command, DNS or remote endpoint.
// Main always has zero argv. The first strict UTF-8/LF stdin line is:
// HUB-LPAC-W0<TAB>1<TAB>32lowerhexnonce<TAB>verb[<TAB>IPv4port<TAB>IPv6port]
// identity => exactly the same four columns + <TAB>ready<LF>, exit 0.
// All other output is that four-column prefix + bounded fixed event fields.
// Root layout: HubLpacW0-<nonce>/runtime/claude-lpac-fixture.exe,
// controller/runtime/outside-canary/other-task/fake-auth each contain marker.txt.
// Marker bytes are ASCII "HUB-LPAC-W0:<nonce>:<directory-name>\n".
// task/tmp contain only new w0-d0.bin..w0-d3.bin, 4096 bytes each.
// Only the controller's independently checked OS/Job evidence can classify a
// quota, process exit, containment or cleanup as passed. This fixture emits
// observations, never a providerReady/probePassed/cleanup success receipt.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ClaudeLpacFixture {
  const string Tag = "HUB-LPAC-W0";
  const int MaxInput = 16384;
  const int ChunkBytes = 4096;
  static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
  static readonly object OutputLock = new object();
  static string nonce, verb, root, exe, runtime;
  static int port4, port6;
  static InputRelay relay;
  static uint cpuSink;
  static readonly List<byte[]> Memory = new List<byte[]>();

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string reserved, desktop, title;
    public int x, y, xSize, ySize, xChars, yChars, fill, flags;
    public short show, reserved2; public IntPtr reservedBytes, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr process, thread; public uint pid, tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
    IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd,
    ref STARTUPINFO startup, out PROCESS_INFORMATION information);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static int Main(string[] args) {
    try {
      if (args.Length != 0) return Reject();
      string line = ReadFirstLineBounded();
      string[] fields = line.Split('\t');
      if (fields.Length < 4 || fields[0] != Tag || fields[1] != "1" || !ValidNonce(fields[2])) return Reject();
      nonce = fields[2]; verb = fields[3];
      bool network = verb == "functional" || verb == "functional-1" || verb == "functional-2" || verb == "functional-3";
      if (fields.Length != (network ? 6 : 4)) return Reject();
      if (network && (!Port(fields[4], out port4) || !Port(fields[5], out port6))) return Reject();
      if (verb == "identity") { Emit("ready"); return 0; }
      if (!KnownVerb(verb)) return Reject();
      BindLayout();
      bool child=verb=="hold"||verb.StartsWith("functional-",StringComparison.Ordinal)||verb.StartsWith("tree-stop-",StringComparison.Ordinal)||verb.StartsWith("tree-eof-",StringComparison.Ordinal);
      relay=new InputRelay(child?Process.GetCurrentProcess().Id:0);
      if(child) {Emit("await-owner",Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture));relay.AwaitSelf();}
      if (network) return Functional(Depth(verb));
      if (verb == "tree-stop" || verb == "tree-eof" || verb == "tree-stop-1" || verb == "tree-stop-2" || verb == "tree-eof-1" || verb == "tree-eof-2") return Tree();
      if (verb == "hold" || verb == "control") { Emit("load-enter", verb); return Hold(); }
      if (verb == "brokers") return Brokers();
      if (verb == "memory") return MemoryLoad();
      if (verb == "process") return ProcessLoad();
      if (verb == "cpu") return CpuLoad();
      if (verb == "wall") { Emit("load-enter", "wall", "30000"); Thread.Sleep(30000); Emit("load-finished", "wall"); return 74; }
      if (verb == "stdout" || verb == "stderr") return OutputLoad(verb == "stderr");
      return Reject();
    } catch (Exception error) {
      if (nonce != null && verb != null) Emit("error", ErrorClass(error), ErrorNumber(error));
      else { try { Console.Error.Write(Tag + "\t1\trejected\n"); } catch { } }
      return 126;
    }
  }

  static int Reject() { try { Console.Error.Write(Tag + "\t1\trejected\n"); } catch { } return 126; }
  static bool KnownVerb(string value) {
    switch(value) {
      case "functional": case "functional-1": case "functional-2": case "functional-3":
      case "tree-stop": case "tree-stop-1": case "tree-stop-2": case "tree-eof": case "tree-eof-1": case "tree-eof-2":
      case "brokers": case "memory": case "process": case "cpu": case "wall": case "stdout": case "stderr": case "hold": case "control": return true;
      default: return false;
    }
  }
  static bool ValidNonce(string value) {
    if (value == null || value.Length != 32) return false;
    foreach(char c in value) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    return true;
  }
  static bool Port(string text, out int value) {
    value = 0;
    if (text.Length < 1 || text.Length > 5) return false;
    foreach(char c in text) if (c < '0' || c > '9') return false;
    return Int32.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value) && value >= 1 && value <= 65535;
  }
  static string ReadFirstLine(Stream input) {
    return ReadLine(input,MaxInput,false);
  }
  static string ReadLine(Stream input,int maximum,bool allowEof) {
    byte[] bytes = new byte[maximum]; int length = 0;
    for (;;) {
      int item = input.ReadByte();
      if(item<0&&length==0&&allowEof)return null;
      if (item < 0 || item == 13 || item == 0) throw new InvalidDataException();
      if (item == 10) break;
      if (length == bytes.Length) throw new InvalidDataException();
      bytes[length++] = (byte)item;
    }
    string line = Utf8.GetString(bytes, 0, length);
    foreach(char c in line) if (c != '\t' && (c < 32 || c > 126)) throw new InvalidDataException();
    return line;
  }
  static string ReadFirstLineBounded() {
    // Broker-created zero-argv copies are not given our command pipe. A missing
    // stdin line must not leave such a copy waiting indefinitely outside the
    // parent's Job. This only bounds Main; it cannot attest CLR startup/exit.
    string line=null;Exception failure=null;
    Thread reader=new Thread(delegate() {try{line=ReadFirstLine(Console.OpenStandardInput());}catch(Exception error){failure=error;}});
    reader.IsBackground=true;reader.Start();
    if(!reader.Join(2000))throw new TimeoutException();
    if(failure!=null)throw failure;
    return line;
  }
  static void BindLayout() {
    exe = Path.GetFullPath(typeof(ClaudeLpacFixture).Assembly.Location);
    runtime = Path.GetDirectoryName(exe); root = Path.GetDirectoryName(runtime);
    if (!String.Equals(Path.GetFileName(exe), "claude-lpac-fixture.exe", StringComparison.OrdinalIgnoreCase) ||
        !String.Equals(Path.GetFileName(runtime), "runtime", StringComparison.OrdinalIgnoreCase) ||
        !String.Equals(Path.GetFileName(root), "HubLpacW0-" + nonce, StringComparison.Ordinal)) throw new InvalidDataException();
    // The controller pins NTFS identities and rejects links before launch.
    // The fixture never accepts a path from input or an environment variable.
  }
  static void Emit(params string[] fields) {
    lock(OutputLock) {
      StringBuilder line = new StringBuilder(Tag + "\t1\t" + nonce + "\t" + verb);
      foreach(string field in fields) {
        if (field == null || field.Length > 128) throw new InvalidDataException();
        foreach(char c in field) if (c < 32 || c > 126 || c == '\t') throw new InvalidDataException();
        line.Append('\t'); line.Append(field);
      }
      line.Append('\n'); byte[] bytes = Utf8.GetBytes(line.ToString());
      Stream output = Console.OpenStandardOutput(); output.Write(bytes, 0, bytes.Length); output.Flush();
    }
  }
  static string ErrorClass(Exception error) {
    error = Inner(error);
    if (error is UnauthorizedAccessException) return "access-denied";
    if (error is FileNotFoundException || error is DirectoryNotFoundException) return "not-found";
    if (error is SocketException) return "socket-error";
    if (error is COMException) return "com-error";
    if (error is Win32Exception) return "win32-error";
    if (error is OutOfMemoryException) return "out-of-memory";
    if (error is InvalidDataException || error is DecoderFallbackException) return "invalid-input";
    return "other-error";
  }
  static Exception Inner(Exception error) {
    while (error is TargetInvocationException && error.InnerException != null) error = error.InnerException;
    return error;
  }
  static string ErrorNumber(Exception error) {
    error = Inner(error);
    SocketException socket = error as SocketException;
    if (socket != null) return socket.NativeErrorCode.ToString(CultureInfo.InvariantCulture);
    Win32Exception native = error as Win32Exception;
    if (native != null) return native.NativeErrorCode.ToString(CultureInfo.InvariantCulture);
    return unchecked((uint)Marshal.GetHRForException(error)).ToString("x8", CultureInfo.InvariantCulture);
  }
  static bool AccessDenied(Exception error) {
    error = Inner(error);
    if (error is UnauthorizedAccessException) return true;
    Win32Exception native = error as Win32Exception;
    if (native != null && native.NativeErrorCode == 5) return true;
    SocketException socket = error as SocketException;
    if (socket != null && socket.SocketErrorCode == SocketError.AccessDenied) return true;
    COMException com = error as COMException;
    return com != null && (unchecked((uint)com.ErrorCode) == 0x80070005 || unchecked((uint)com.ErrorCode) == 0x80041003);
  }
  static string FixedPath(string folder, string name) { return Path.Combine(Path.Combine(root, folder), name); }
  static byte[] Marker(string folder) { return Encoding.ASCII.GetBytes(Tag + ":" + nonce + ":" + folder + "\n"); }
  static bool Same(byte[] a, byte[] b) { if (a.Length != b.Length) return false; for(int i=0;i<a.Length;i++) if (a[i] != b[i]) return false; return true; }

  static bool MarkerAttempt(string folder, bool write, bool expectDenied) {
    string operation = write ? "write" : "read";
    bool progressed=false;
    Emit("attempt", "file", folder, operation);
    try {
      using(FileStream file = new FileStream(FixedPath(folder, "marker.txt"), FileMode.Open, write ? FileAccess.Write : FileAccess.Read, FileShare.ReadWrite)) {
        if (write) { progressed=true;file.WriteByte((byte)'H'); file.Flush(true); }
        else {
          byte[] expected = Marker(folder), actual = new byte[expected.Length + 1]; int count = 0, got;
          while (count < actual.Length && (got = file.Read(actual, count, actual.Length-count)) > 0) {progressed=true;count += got;}
          if (count != expected.Length) { Emit("file", folder, operation, "mismatch", "0"); return false; }
          byte[] exact = new byte[count]; Buffer.BlockCopy(actual, 0, exact, 0, count);
          if (!Same(exact, expected)) { Emit("file", folder, operation, "mismatch", "0"); return false; }
        }
      }
      Emit("file", folder, operation, "allowed", "0"); return !expectDenied;
    } catch(Exception error) {
      bool denied = !progressed&&AccessDenied(error);
      Emit("file", folder, operation, progressed?"allowed-error":denied ? "deny" : "not-measured", ErrorNumber(error));
      return expectDenied && denied;
    }
  }
  static bool PositiveFile(string folder, int depth) {
    string name = "w0-d" + depth.ToString(CultureInfo.InvariantCulture) + ".bin";
    Emit("attempt", "file", folder, "create-read-write");
    try {
      byte[] expected = new byte[ChunkBytes]; for(int i=0;i<expected.Length;i++) expected[i]=(byte)(i % 251);
      using(FileStream file = new FileStream(FixedPath(folder, name), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read)) {
        file.Write(expected, 0, expected.Length); file.Flush(true); file.Position = 0;
        byte[] actual = new byte[expected.Length]; int total=0, got;
        while(total<actual.Length && (got=file.Read(actual,total,actual.Length-total))>0) total+=got;
        if(total!=actual.Length || !Same(actual, expected) || file.ReadByte()!=-1) { Emit("file",folder,"create-read-write","mismatch","0");return false; }
      }
      Emit("file", folder, "create-read-write", "allowed", ChunkBytes.ToString(CultureInfo.InvariantCulture)); return true;
    } catch(Exception error) { Emit("file", folder, "create-read-write", "not-measured", ErrorNumber(error)); return false; }
  }
  static bool Files(int depth) {
    bool ok = PositiveFile("task",depth); ok = PositiveFile("tmp",depth) && ok;
    ok = MarkerAttempt("runtime",false,false) && ok;
    ok = MarkerAttempt("runtime",true,true) && ok;
    foreach(string folder in new string[]{"controller","outside-canary","other-task","fake-auth"}) {
      ok = MarkerAttempt(folder,false,true) && ok;
      ok = MarkerAttempt(folder,true,true) && ok;
    }
    return ok;
  }
  static bool Network(bool ipv6) {
    string family = ipv6 ? "ipv6" : "ipv4";
    bool connected=false;
    Emit("attempt", "network", family);
    try {
      using(Socket socket = new Socket(ipv6 ? AddressFamily.InterNetworkV6 : AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp)) {
        IAsyncResult connect = socket.BeginConnect(ipv6 ? IPAddress.IPv6Loopback : IPAddress.Loopback, ipv6 ? port6 : port4, null, null);
        using(WaitHandle wait = connect.AsyncWaitHandle) { if(!wait.WaitOne(1500)) { Emit("network",family,"not-measured","timeout");return false; } }
        socket.EndConnect(connect);
        connected=true;Emit("network",family,"allowed","0");
        socket.SendTimeout=1000;byte[] message=Encoding.ASCII.GetBytes(nonce+"\tfixture\n");socket.Send(message);
        return false;
      }
    } catch(Exception error) { bool denied=!connected&&AccessDenied(error);Emit("network",family,connected?"allowed-error":denied?"deny":"not-measured",ErrorNumber(error));return denied; }
  }
  static int Depth(string value) { return value == "functional" ? 0 : value[value.Length-1]-'0'; }
  static int Functional(int depth) {
    Emit("load-enter","functional",depth.ToString(CultureInfo.InvariantCulture));
    bool ok=Files(depth);ok=Network(false)&&ok;ok=Network(true)&&ok;
    // Never continue a failing boundary into more process starts.
    if(!ok) { Emit("functional","failed",depth.ToString(CultureInfo.InvariantCulture));return 2; }
    if(depth<3) {
      using(Process child=StartChild("functional-"+(depth+1).ToString(CultureInfo.InvariantCulture),true)) {
        if(!child.WaitForExit(12000)) { Emit("functional","not-measured","child-timeout");return 2; }
        child.WaitForExit();if(child.ExitCode!=0) {Emit("functional","failed","child");return 2;}
        relay.Remove(child);
      }
    }
    Emit("functional","observed",depth.ToString(CultureInfo.InvariantCulture));return 0;
  }

  static Process StartChild(string childVerb, bool withPorts) {
    if (!KnownVerb(childVerb)) throw new InvalidDataException();
    Emit("spawn-attempt",childVerb);
    ProcessStartInfo start=new ProcessStartInfo(exe);start.Arguments="";start.WorkingDirectory=runtime;
    start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardInput=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
    Process child=new Process();child.StartInfo=start;
    child.OutputDataReceived+=delegate(object sender,DataReceivedEventArgs data) { Forward(data.Data,false); };
    child.ErrorDataReceived+=delegate(object sender,DataReceivedEventArgs data) { Forward(data.Data,true); };
    try {
      if(!child.Start())throw new InvalidOperationException();
      Emit("spawned",childVerb,child.Id.ToString(CultureInfo.InvariantCulture));
      relay.Add(child);
      child.BeginOutputReadLine();child.BeginErrorReadLine();
      relay.Command(child,Tag+"\t1\t"+nonce+"\t"+childVerb+(withPorts?"\t"+port4.ToString(CultureInfo.InvariantCulture)+"\t"+port6.ToString(CultureInfo.InvariantCulture):"")+"\n");
      return child;
    } catch { child.Dispose();throw; }
  }
  static void Forward(string line,bool stderr) {
    if(line==null)return;
    // The only child is this fixed, pinned fixture. Still do not relay an
    // arbitrary line/payload or a different run's nonce into controller output.
    if(line.Length>2048||!line.StartsWith(Tag+"\t1\t"+nonce+"\t",StringComparison.Ordinal)) {try{Emit("child-output","not-measured",stderr?"stderr":"stdout");}catch{}return;}
    foreach(char c in line) if(c!='\t'&&(c<32||c>126)) {try{Emit("child-output","not-measured","encoding");}catch{}return;}
    lock(OutputLock) {try{byte[] bytes=Utf8.GetBytes(line+"\n");Stream output=Console.OpenStandardOutput();output.Write(bytes,0,bytes.Length);output.Flush();}catch{}}
  }
  static int Hold() {
    // EOF is a lifecycle signal only. Extra input is never a command channel.
    bool valid=relay.AwaitEnd();
    Emit("eof",valid?"observed":"invalid-input");return valid?0:126;
  }
  static int Tree() {
    int depth=verb.EndsWith("-1",StringComparison.Ordinal)?1:verb.EndsWith("-2",StringComparison.Ordinal)?2:0;
    string family=verb.StartsWith("tree-stop",StringComparison.Ordinal)?"tree-stop":"tree-eof";
    Emit("load-enter","tree",depth.ToString(CultureInfo.InvariantCulture));
    Process child=null;
    try {
      if(depth<2)child=StartChild(family+"-"+(depth+1).ToString(CultureInfo.InvariantCulture),false);
      int code=Hold();
      if(child!=null) {if(!child.WaitForExit(5000)){Emit("tree","not-measured","child-timeout");return 2;}child.WaitForExit();if(child.ExitCode!=0)return 2;relay.Remove(child);}
      return code;
    } finally {if(child!=null)child.Dispose();}
  }

  static bool Breakaway() {
    Emit("spawn-attempt","breakaway");
    STARTUPINFO startup=new STARTUPINFO();startup.cb=Marshal.SizeOf(typeof(STARTUPINFO));PROCESS_INFORMATION child;
    bool created=CreateProcess(exe,new StringBuilder("\""+exe+"\""),IntPtr.Zero,IntPtr.Zero,false,0x01000000|0x08000000|0x00000004,IntPtr.Zero,runtime,ref startup,out child);
    if(!created) {int code=Marshal.GetLastWin32Error();Emit("broker","breakaway",code==5?"deny":"not-measured",code.ToString(CultureInfo.InvariantCulture));return code==5;}
    try {
      Emit("broker","breakaway","allowed-suspended",child.pid.ToString(CultureInfo.InvariantCulture));
      // An unexpectedly created breakaway child never gets its first instruction.
      bool stopped=TerminateProcess(child.process,125);uint waited=WaitForSingleObject(child.process,5000);
      Emit("breakaway-cleanup",stopped&&waited==0?"observed":"unknown");
      return false;
    } finally {CloseHandle(child.thread);CloseHandle(child.process);}
  }
  static object Invoke(object target,string method,object[] args) {
    return target.GetType().InvokeMember(method,BindingFlags.InvokeMethod,null,target,args,CultureInfo.InvariantCulture);
  }
  static void ReleaseCom(object value) {if(value!=null&&Marshal.IsComObject(value))try{Marshal.FinalReleaseComObject(value);}catch{}}
  static bool WmiCreate() {
    object locator=null,services=null,processClass=null;
    Emit("spawn-attempt","wmi");
    try {
      Type type=Type.GetTypeFromProgID("WbemScripting.SWbemLocator",true);locator=Activator.CreateInstance(type);
      services=Invoke(locator,"ConnectServer",new object[]{".","root\\cimv2"});processClass=Invoke(services,"Get",new object[]{"Win32_Process"});
      object[] args=new object[]{"\""+exe+"\"",runtime,null,0};ParameterModifier modifier=new ParameterModifier(4);modifier[3]=true;
      object result=processClass.GetType().InvokeMember("Create",BindingFlags.InvokeMethod,null,processClass,args,new ParameterModifier[]{modifier},CultureInfo.InvariantCulture,null);
      uint code=Convert.ToUInt32(result,CultureInfo.InvariantCulture);
      if(code==2) {Emit("broker","wmi","deny","2");return true;}
      if(code==0) {Emit("broker","wmi","allowed",Convert.ToString(args[3],CultureInfo.InvariantCulture));return false;}
      Emit("broker","wmi","not-measured",code.ToString(CultureInfo.InvariantCulture));return false;
    } catch(Exception error) {bool denied=AccessDenied(error);Emit("broker","wmi",denied?"deny":"not-measured",ErrorNumber(error));return denied;}
    finally {ReleaseCom(processClass);ReleaseCom(services);ReleaseCom(locator);}
  }
  static bool ShellCreate() {
    object shell=null;Emit("spawn-attempt","com-shell");
    try {
      Type type=Type.GetTypeFromProgID("Shell.Application",true);shell=Activator.CreateInstance(type);
      Invoke(shell,"ShellExecute",new object[]{exe,"",runtime,"open",0});
      // ShellExecute's COM API supplies no PID/exit evidence. No exception is
      // NOT a containment denial, nor proof the fixed target actually started.
      Emit("broker","com-shell","not-measured","no-pid");return false;
    } catch(Exception error) {bool denied=AccessDenied(error);Emit("broker","com-shell",denied?"deny":"not-measured",ErrorNumber(error));return denied;}
    finally {ReleaseCom(shell);}
  }
  static int Brokers() {
    Emit("load-enter","brokers");
    if(!Breakaway()||!WmiCreate()||!ShellCreate())return 2;
    Emit("brokers","denials-observed");return 0;
  }

  static int MemoryLoad() {
    Emit("load-enter","memory","671088640");
    try {
      for(int index=0;index<40;index++) {byte[] bytes=new byte[16*1024*1024];for(int at=0;at<bytes.Length;at+=4096)bytes[at]=1;Memory.Add(bytes);}
      Emit("load-finished","memory","limit-not-observed");return 74;
    } catch(OutOfMemoryException) {Emit("quota-observation","memory","out-of-memory");return 73;}
  }
  static int ProcessLoad() {
    Emit("load-enter","process","8");List<Process> children=new List<Process>();
    try {
      for(int index=0;index<8;index++) {
        try {Process child=StartChild("hold",false);children.Add(child);relay.AwaitForwarded(child.Id);}
        catch(Exception error) {Emit("quota-observation","process",ErrorClass(error),ErrorNumber(error),children.Count.ToString(CultureInfo.InvariantCulture));return 73;}
      }
      Emit("load-finished","process","limit-not-observed");return 74;
    } finally {
      foreach(Process child in children)try{relay.CloseInput(child);}catch{}
      foreach(Process child in children) {try{child.WaitForExit(5000);relay.Remove(child);}catch{}child.Dispose();}
    }
  }
  static int CpuLoad() {
    Emit("load-enter","cpu","15000");Stopwatch time=Stopwatch.StartNew();
    while(time.ElapsedMilliseconds<15000) {for(int i=0;i<65536;i++)cpuSink=unchecked(cpuSink*1664525U+1013904223U);}
    Emit("load-finished","cpu","limit-not-observed");return 74;
  }
  static int OutputLoad(bool stderr) {
    string target=stderr?"stderr":"stdout";Emit("load-enter",target,"1048576");
    Stream output=stderr?Console.OpenStandardError():Console.OpenStandardOutput();byte[] bytes=new byte[1024];for(int i=0;i<bytes.Length;i++)bytes[i]=(byte)'X';
    for(int i=0;i<1024;i++){output.Write(bytes,0,bytes.Length);output.Flush();}
    Emit("load-finished",target,"limit-not-observed");return 74;
  }

  // Exactly one reader owns all input after the first command. ACK is a fixed
  // transport signal, not a command/authorization API exposed to a provider.
  // The owner controller must hold and verify each actual child HANDLE before
  // sending it; fixture self-report and an ACK alone do not prove containment.
  sealed class InputRelay {
    readonly object gate=new object();
    readonly Dictionary<int,Process> children=new Dictionary<int,Process>();
    readonly Dictionary<int,bool> acknowledgements=new Dictionary<int,bool>();
    readonly ManualResetEvent ended=new ManualResetEvent(false),selfAck=new ManualResetEvent(false);
    readonly int self;bool eof,failed;int lines;
    public InputRelay(int ownPid) {self=ownPid;Thread input=new Thread(Read);input.IsBackground=true;input.Start();}
    public void Add(Process child) {lock(gate){if(eof||failed)throw new InvalidDataException();children.Add(child.Id,child);}}
    public void Command(Process child,string line) {lock(gate){if(eof||failed||!children.ContainsKey(child.Id))throw new InvalidDataException();child.StandardInput.Write(line);child.StandardInput.Flush();}}
    public void Remove(Process child) {lock(gate){children.Remove(child.Id);}}
    public void CloseInput(Process child) {lock(gate){child.StandardInput.Close();}}
    public void AwaitSelf() {if(WaitHandle.WaitAny(new WaitHandle[]{selfAck,ended},5000)!=0)throw new TimeoutException();lock(gate){if(failed||!acknowledgements.ContainsKey(self))throw new InvalidDataException();}}
    public void AwaitForwarded(int pid) {
      Stopwatch time=Stopwatch.StartNew();
      lock(gate) {
        while(!acknowledgements.ContainsKey(pid)&&!failed&&!eof) {int remaining=5000-(int)time.ElapsedMilliseconds;if(remaining<=0)throw new TimeoutException();Monitor.Wait(gate,remaining);}
        if(failed||!acknowledgements.ContainsKey(pid))throw new InvalidDataException();
      }
    }
    public bool AwaitEnd() {ended.WaitOne();lock(gate){return eof&&!failed;}}
    void Read() {
      try {
        Stream input=Console.OpenStandardInput();
        for(;;) {
          string line=ReadLine(input,128,true);if(line==null){lock(gate){eof=true;foreach(Process child in children.Values)try{child.StandardInput.Close();}catch{}Monitor.PulseAll(gate);}ended.Set();return;}
          string[] fields=line.Split('\t');int pid;
          if(++lines>16||fields.Length!=5||fields[0]!=Tag||fields[1]!="1"||fields[2]!=nonce||fields[3]!="ack"||!Pid(fields[4],out pid))throw new InvalidDataException();
          lock(gate) {
            if(acknowledgements.ContainsKey(pid))throw new InvalidDataException();
            if(pid==self&&self!=0) {acknowledgements.Add(pid,true);selfAck.Set();Monitor.PulseAll(gate);continue;}
            Process target;
            if(!children.TryGetValue(pid,out target)) {
              if(children.Count!=1)throw new InvalidDataException();
              target=null;foreach(Process candidate in children.Values)target=candidate;
            }
            if(target==null||target.HasExited)throw new InvalidDataException();
            target.StandardInput.Write(line+"\n");target.StandardInput.Flush();acknowledgements.Add(pid,true);Monitor.PulseAll(gate);
          }
        }
      } catch {
        lock(gate){failed=true;foreach(Process child in children.Values)try{child.StandardInput.Close();}catch{}Monitor.PulseAll(gate);}ended.Set();
        try{Emit("input","rejected");}catch{}
      }
    }
    static bool Pid(string value,out int pid) {pid=0;if(value.Length<1||value.Length>10)return false;foreach(char c in value)if(c<'0'||c>'9')return false;return Int32.TryParse(value,NumberStyles.None,CultureInfo.InvariantCulture,out pid)&&pid>0;}
  }
}
