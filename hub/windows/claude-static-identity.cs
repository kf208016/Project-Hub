// Fixed, read-only Claude package snapshot. Never executes a vendor image.
using System;
using System.IO;
using System.Text;
using System.Globalization;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class HubClaudeStaticIdentity {
  internal const string Version = "2.1.252";
  internal const long ExecutableBytes = 217406624;
  internal const string ExecutableSHA256 = "fe688ecde90d65fff0b2dd097597439774116077d80a3c1e131a7e47db307b1a";
  internal const string ManifestSHA256 = "8ea9f25853a8ef115de2cfe4621e02184daeada5e46de7f23cf8b230682f1f2b";
  [StructLayout(LayoutKind.Sequential)] internal struct FT { internal uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] internal struct FI {
    internal uint Attributes; internal FT Creation, Access, Write;
    internal uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] internal static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool GetFileInformationByHandle(SafeFileHandle file, out FI info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(SafeFileHandle file);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder name, uint size, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, IntPtr info, uint size);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserProfileDirectoryW(IntPtr token, StringBuilder path, ref uint size);

  internal sealed class Rejected : Exception {
    internal readonly string Code; internal readonly int NativeError;
    internal Rejected(string code, int error) { Code=code; NativeError=error; }
  }
  internal static void Need(bool value, string code) { if(!value) throw new Rejected(code,0); }
  static void Win(bool value, string code) { if(!value) throw new Rejected(code,Marshal.GetLastWin32Error()); }
  internal static string Hash(Stream stream) { stream.Position=0; using(SHA256 sha=SHA256.Create()) return Hex(sha.ComputeHash(stream)); }
  static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-","").ToLowerInvariant(); }
  static string HashText(string text) { using(SHA256 sha=SHA256.Create()) return Hex(sha.ComputeHash(Encoding.UTF8.GetBytes(text))); }
  static ulong Number(uint low, uint high) { return ((ulong)high<<32)|low; }
  internal static string Absolute(string path) {
    Need(path!=null && path.Length>3 && path.Length<=32760 && Char.IsLetter(path[0]) && path[1]==':' && path[2]=='\\',"STATIC_PATH_REJECTED");
    foreach(string part in path.Substring(3).Split('\\')) {
      Need(part.Length>0 && part.Length<=255 && part!="." && part!=".." && !part.EndsWith(".") && !part.EndsWith(" "),"STATIC_PATH_REJECTED");
      foreach(char c in part) Need(c>=32 && c!=127 && "/:*?\"<>|".IndexOf(c)<0,"STATIC_PATH_REJECTED");
    }
    try { Need(String.Equals(Path.GetFullPath(path),path,StringComparison.OrdinalIgnoreCase),"STATIC_PATH_REJECTED"); }
    catch { throw new Rejected("STATIC_PATH_REJECTED",0); }
    return path;
  }
  static void FinalPath(SafeFileHandle handle, string expected) {
    StringBuilder path=new StringBuilder(32768); uint count=GetFinalPathNameByHandleW(handle,path,32768,0);
    Win(count>0,"STATIC_PATH_QUERY_FAILED");
    Need(count<32768 && String.Equals(path.ToString(),"\\\\?\\"+expected,StringComparison.OrdinalIgnoreCase),"STATIC_PATH_CHANGED");
  }
  internal static FI Query(SafeFileHandle handle, bool directory) {
    FI info; Win(GetFileInformationByHandle(handle,out info),"STATIC_IDENTITY_QUERY_FAILED");
    Need((info.Attributes&0x400)==0,"STATIC_REPARSE_REJECTED");
    Need(((info.Attributes&0x10)!=0)==directory && (info.Attributes&0x40)==0,"STATIC_FILE_TYPE_REJECTED");
    Need(Number(info.IndexLow,info.IndexHigh)!=0 && (directory || info.Links>0),"STATIC_IDENTITY_REJECTED");
    return info;
  }
  internal static bool Same(FI a, FI b) {
    return a.VolumeSerial==b.VolumeSerial && a.IndexLow==b.IndexLow && a.IndexHigh==b.IndexHigh &&
      a.SizeLow==b.SizeLow && a.SizeHigh==b.SizeHigh && a.Links==b.Links && a.Attributes==b.Attributes &&
      a.Creation.Low==b.Creation.Low && a.Creation.High==b.Creation.High && a.Write.Low==b.Write.Low && a.Write.High==b.Write.High;
  }
  internal static HubPinnedRoot PinParent(string file) {
    string parent=Path.GetDirectoryName(Absolute(file));
    using(SafeFileHandle handle=CreateFileW(parent,0x1000a0,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
      Win(!handle.IsInvalid,"STATIC_PARENT_OPEN_FAILED"); FI info=Query(handle,true); FinalPath(handle,parent);
      string fingerprint=HashText(parent+"\n"+info.VolumeSerial.ToString(CultureInfo.InvariantCulture)+"\n"+Number(info.IndexLow,info.IndexHigh).ToString(CultureInfo.InvariantCulture));
      try { return new HubPinnedRoot(parent,fingerprint); }
      catch { throw new Rejected("STATIC_NAMESPACE_REJECTED",0); }
    }
  }
  // The fixed target is the unnamed data stream; reject any extra stream too.
  static void Streams(SafeFileHandle handle) {
    IntPtr buffer=Marshal.AllocHGlobal(65536);
    try {
      Win(GetFileInformationByHandleEx(handle,7,buffer,65536),"STATIC_STREAM_QUERY_FAILED");
      uint next=unchecked((uint)Marshal.ReadInt32(buffer,0)),length=unchecked((uint)Marshal.ReadInt32(buffer,4));
      Need(next==0 && length==14 && Marshal.PtrToStringUni(IntPtr.Add(buffer,24),7)=="::$DATA","STATIC_ADS_REJECTED");
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  internal sealed class HeldFile : IDisposable {
    internal SafeFileHandle Handle; internal FileStream Stream; internal FI Before;
    readonly string path;
    internal HeldFile(string name, long maxBytes) {
      path=Absolute(name);
      try {
        Handle=CreateFileW(path,0x80000000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
        Win(!Handle.IsInvalid,"STATIC_FILE_OPEN_FAILED");
        Need(GetFileType(Handle)==1,"STATIC_FILE_TYPE_REJECTED"); Before=Query(Handle,false); FinalPath(Handle,path); Streams(Handle);
        Need(Number(Before.SizeLow,Before.SizeHigh)>0 && Number(Before.SizeLow,Before.SizeHigh)<=(ulong)maxBytes,"STATIC_SIZE_REJECTED");
        Stream=new FileStream(Handle,FileAccess.Read,65536,false);
      } catch { Dispose(); throw; }
    }
    internal void Verify() {
      Need(Same(Before,Query(Handle,false)),"STATIC_IDENTITY_CHANGED"); FinalPath(Handle,path); Streams(Handle);
    }
    internal Dictionary<string,object> Identity() {
      return new Dictionary<string,object>{{"volume",Before.VolumeSerial.ToString(CultureInfo.InvariantCulture)},
        {"fileId",Number(Before.IndexLow,Before.IndexHigh).ToString(CultureInfo.InvariantCulture)},
        {"bytes",Number(Before.SizeLow,Before.SizeHigh).ToString(CultureInfo.InvariantCulture)},
        {"links",Before.Links.ToString(CultureInfo.InvariantCulture)},
        {"attributes",Before.Attributes},{"createdFileTime",Number(Before.Creation.Low,Before.Creation.High).ToString(CultureInfo.InvariantCulture)},
        {"modifiedFileTime",Number(Before.Write.Low,Before.Write.High).ToString(CultureInfo.InvariantCulture)}};
    }
    public void Dispose() { if(Stream!=null) {Stream.Dispose(); Stream=null;} if(Handle!=null) {Handle.Dispose(); Handle=null;} }
  }
  static string FixedBase() {
    using(WindowsIdentity identity=WindowsIdentity.GetCurrent()) {
      uint size=32768; StringBuilder profile=new StringBuilder((int)size);
      Win(GetUserProfileDirectoryW(identity.Token,profile,ref size),"STATIC_PROFILE_LOCATION_FAILED");
      return Absolute(Path.Combine(profile.ToString(),"AppData","Roaming","npm","node_modules","@anthropic-ai","claude-code"));
    }
  }
  static Dictionary<string,object> Envelope(bool passed, string code) {
    return new Dictionary<string,object>{{"schemaVersion",1},{"kind","fixed-claude-static-identity"},{"passed",passed},
      {"code",code},{"providerReady",false},{"vendorExecuted",false},{"authRead",false}};
  }
  static Dictionary<string,object> Inspect() {
    string package=FixedBase(),manifest=Path.Combine(package,"package.json"),executable=Path.Combine(package,"bin","claude.exe");
    using(HubPinnedRoot manifestParent=PinParent(manifest))
    using(HubPinnedRoot executableParent=PinParent(executable))
    using(HeldFile manifestFile=new HeldFile(manifest,262144))
    using(HeldFile executableFile=new HeldFile(executable,ExecutableBytes)) {
      Need(Number(executableFile.Before.SizeLow,executableFile.Before.SizeHigh)==ExecutableBytes,"STATIC_BYTES_MISMATCH");
      string manifestHash=Hash(manifestFile.Stream),executableHash=Hash(executableFile.Stream);
      Need(manifestHash==ManifestSHA256,"STATIC_MANIFEST_MISMATCH"); Need(executableHash==ExecutableSHA256,"STATIC_BYTES_MISMATCH");
      manifestFile.Stream.Position=0; byte[] content=new byte[(int)manifestFile.Stream.Length]; int read=0;
      while(read<content.Length) {int n=manifestFile.Stream.Read(content,read,content.Length-read); Need(n>0,"STATIC_MANIFEST_CHANGED");read+=n;}
      JavaScriptSerializer serializer=new JavaScriptSerializer();serializer.MaxJsonLength=262144;serializer.RecursionLimit=32;
      Dictionary<string,object> parsed=serializer.DeserializeObject(new UTF8Encoding(false,true).GetString(content)) as Dictionary<string,object>;
      Need(parsed!=null && parsed.ContainsKey("version") && parsed["version"] is string && (string)parsed["version"]==Version,"STATIC_VERSION_MISMATCH");
      Need(Hash(manifestFile.Stream)==manifestHash && Hash(executableFile.Stream)==executableHash,"STATIC_HASH_CHANGED");
      manifestFile.Verify();executableFile.Verify();manifestParent.Verify();executableParent.Verify();
      Dictionary<string,object> result=Envelope(true,"STATIC_IDENTITY_MATCHED");
      result["expected"]=new Dictionary<string,object>{{"version",Version},{"executableBytes",ExecutableBytes},{"executableSHA256",ExecutableSHA256},{"manifestSHA256",ManifestSHA256}};
      result["manifest"]=new Dictionary<string,object>{{"identity",manifestFile.Identity()},{"sha256",manifestHash}};
      result["executable"]=new Dictionary<string,object>{{"identity",executableFile.Identity()},{"sha256",executableHash}};
      result["heldTogether"]=true;result["namespacePinned"]=true;result["scope"]="held-read-only-static-snapshot";
      return result;
    }
  }
  public static int Main(string[] args) {
    Dictionary<string,object> result;
    try { Need(args.Length==1 && args[0]=="--inspect-fixed-claude","STATIC_SWITCH_REJECTED");result=Inspect(); }
    catch(Rejected error) {result=Envelope(false,error.Code);result["nativeError"]=error.NativeError;}
    catch {result=Envelope(false,"STATIC_IDENTITY_UNVERIFIED");result["nativeError"]=0;}
    Console.Out.WriteLine(new JavaScriptSerializer().Serialize(result)); return (bool)result["passed"]?0:1;
  }
}
