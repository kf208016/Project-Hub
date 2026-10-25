// Private, local installer primitive. Never exposed as a Hub/MCP capability.
using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

class InstallFiles {
 const uint READ=0x80000000,WRITE=0x40000000,ATTR=0x80,DELETE=0x10000,SHARE_READ=1,OPEN=3,CREATE_NEW=1,OPEN_REPARSE=0x200000,BACKUP=0x2000000,PROCESS_QUERY_LIMITED_INFORMATION=0x1000;
 [StructLayout(LayoutKind.Sequential)] struct Info {public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
 [DllImport("kernel32.dll",EntryPoint="CreateFileW",ExactSpelling=true,CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr security,uint mode,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int kind,ref int information,int length);
 [DllImport("kernel32.dll",EntryPoint="CreateDirectoryW",ExactSpelling=true,CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string path,IntPtr security);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle h,uint code,IntPtr i,int n,byte[] o,int m,out int returned,IntPtr overlapped);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetDriveType(string root);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformation(string root,StringBuilder volume,int capacity,out uint serial,out uint max,out uint flags,StringBuilder fs,int fsCapacity);
 [DllImport("kernel32.dll",SetLastError=true)] static extern SafeFileHandle OpenProcess(uint access,bool inherit,int processId);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(SafeFileHandle process,out System.Runtime.InteropServices.ComTypes.FILETIME created,out System.Runtime.InteropServices.ComTypes.FILETIME exited,out System.Runtime.InteropServices.ComTypes.FILETIME kernel,out System.Runtime.InteropServices.ComTypes.FILETIME user);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(SafeFileHandle process,uint flags,StringBuilder path,ref int size);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int GetCurrentPackageFullName(ref uint length,StringBuilder name);
 static object PackageContext(){uint length=0;int code=GetCurrentPackageFullName(ref length,null);if(code==15700)return new{ok=true,packaged=false,packageFullName=(string)null};if(code!=122||length==0||length>32768)Fail("PACKAGE_CONTEXT_UNKNOWN");var name=new StringBuilder((int)length);if(GetCurrentPackageFullName(ref length,name)!=0||name.Length==0)Fail("PACKAGE_CONTEXT_UNKNOWN");return new{ok=true,packaged=true,packageFullName=name.ToString()};}
 static JavaScriptSerializer json;
 static InstallFiles(){
  // Configure .NET Framework before its path handling is initialized. Authority
  // and fingerprint strings stay canonical drive-local paths without a prefix.
  AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false);
  AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);
  json=new JavaScriptSerializer {MaxJsonLength=8*1024*1024,RecursionLimit=32};
 }
 static void Fail(string code){throw new InvalidOperationException(code);}
 static string Hex(byte[] b){return BitConverter.ToString(b).Replace("-","").ToLowerInvariant();}
 static string Hash(byte[] b){using(var h=SHA256.Create())return Hex(h.ComputeHash(b));}
 static string Hash(Stream s){using(var h=SHA256.Create())return Hex(h.ComputeHash(s));}
 static string S(Dictionary<string,object> o,string k){object v;if(!o.TryGetValue(k,out v)||!(v is string))Fail("INPUT_REJECTED");return (string)v;}
 // Leave room for the four-character native prefix and terminating NUL.
 static void DrivePath(string p,bool internalDriveRoot){if(String.IsNullOrEmpty(p)||p.Length>32763||p.Length<3||!((p[0]>='A'&&p[0]<='Z')||(p[0]>='a'&&p[0]<='z'))||p[1]!=':'||p[2]!='\\'||p.IndexOf(':',2)>=0||p.IndexOf('\0')>=0)Fail("PATH_REJECTED");if(internalDriveRoot&&p.Length==3)return;foreach(var part in p.Substring(3).Split('\\'))if(part.Length==0||part=="."||part==".."||part.EndsWith(".")||part.EndsWith(" ")||part.IndexOfAny(new char[]{'<','>','"','|','?','*','/'})>=0||System.Text.RegularExpressions.Regex.IsMatch(part,"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)",System.Text.RegularExpressions.RegexOptions.IgnoreCase))Fail("PATH_REJECTED");}
 // The prefix is private to OS calls. Never accept a caller-provided device/UNC
 // namespace or use it in root/file identity evidence.
 static string NativePath(string p){DrivePath(p,true);return "\\\\?\\"+p;}
 static SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr security,uint mode,uint flags,IntPtr template){return CreateFileW(NativePath(p),a,s,security,mode,flags,template);}
 static bool CreateDirectory(string p,IntPtr security){return CreateDirectoryW(NativePath(p),security);}
 static string Full(string p){DrivePath(p,false);var full=Path.GetFullPath(p);if(!String.Equals(full,p,StringComparison.OrdinalIgnoreCase))Fail("PATH_REJECTED");uint a,b,c;var fs=new StringBuilder(32);if(GetDriveType(Path.GetPathRoot(full))!=3||!GetVolumeInformation(Path.GetPathRoot(full),new StringBuilder(256),256,out a,out b,out c,fs,32)||fs.ToString()!="NTFS")Fail("LOCAL_NTFS_REQUIRED");return full;}
 static string Relative(string root,string p){if(String.IsNullOrEmpty(p)||p.Length>32768||p.Contains("\\")||Path.IsPathRooted(p)||p.IndexOf(':')>=0)Fail("RELATIVE_PATH_REJECTED");foreach(var part in p.Split('/'))if(part.Length==0||part=="."||part=="..")Fail("RELATIVE_PATH_REJECTED");return Full(Path.Combine(root,p.Replace('/',Path.DirectorySeparatorChar)));}
 static Info Check(SafeFileHandle h,bool dir){if(h.IsInvalid)Fail("OPEN_FAILED");Info info;if(!GetFileInformationByHandle(h,out info)||(info.Attributes&0x400)!=0||((info.Attributes&0x10)!=0)!=dir||(!dir&&info.Links!=1))Fail("OBJECT_REJECTED");int returned;var buffer=new byte[16384];if(DeviceIoControl(h,0x900A8,IntPtr.Zero,0,buffer,buffer.Length,out returned,IntPtr.Zero)||Marshal.GetLastWin32Error()!=4390)Fail("REPARSE_REJECTED");return info;}
 static string Fingerprint(Info info){return Hash(Encoding.UTF8.GetBytes(info.Volume+":"+info.IndexHigh+":"+info.IndexLow));}
 // Read-only compatibility evidence for the existing scoped/web broker identity
 // algorithm. The installer's own authority fingerprint remains unchanged.
 static string WebFingerprint(string full,Info info){ulong index=((ulong)info.IndexHigh<<32)|info.IndexLow;return Hash(Encoding.UTF8.GetBytes(full+"\n"+info.Volume.ToString(System.Globalization.CultureInfo.InvariantCulture)+"\n"+index.ToString(System.Globalization.CultureInfo.InvariantCulture)));}
 class Pins:IDisposable {
  List<SafeFileHandle> handles=new List<SafeFileHandle>();HashSet<string> seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);public string Root;public string Fingerprint;public string WebRootFingerprint;
  public Pins(string root,bool create){Root=Full(root);string p=Path.GetPathRoot(Root);Pin(p);foreach(var part in Root.Substring(p.Length).Split('\\')){p=Path.Combine(p,part);if(!Directory.Exists(NativePath(p))){if(!create)Fail("ROOT_MISSING");Directory.CreateDirectory(NativePath(p));}Pin(p);}var info=Check(handles[handles.Count-1],true);Fingerprint=InstallFiles.Fingerprint(info);WebRootFingerprint=InstallFiles.WebFingerprint(Root,info);}
  void Pin(string p){if(seen.Contains(p))return;var h=CreateFile(p,ATTR,SHARE_READ,IntPtr.Zero,OPEN,OPEN_REPARSE|BACKUP,IntPtr.Zero);try{Check(h,true);handles.Add(h);seen.Add(p);}catch{h.Dispose();throw;}}
  public void Parent(string file,bool create){var p=Path.GetDirectoryName(file);if(!p.StartsWith(Root+"\\",StringComparison.OrdinalIgnoreCase)&&!String.Equals(p,Root,StringComparison.OrdinalIgnoreCase))Fail("OUTSIDE_ROOT");string current=Root;foreach(var part in p.Substring(Root.Length).TrimStart('\\').Split(new[]{'\\'},StringSplitOptions.RemoveEmptyEntries)){current=Path.Combine(current,part);if(!Directory.Exists(NativePath(current))){if(!create)Fail("PARENT_MISSING");Directory.CreateDirectory(NativePath(current));}Pin(current);}}
  public void Dispose(){for(int i=handles.Count-1;i>=0;i--)handles[i].Dispose();}
 }
 static FileStream File(string file,bool write,bool create){var h=CreateFile(file,READ|(write?WRITE:0),write?0:SHARE_READ,IntPtr.Zero,create?CREATE_NEW:OPEN,OPEN_REPARSE,IntPtr.Zero);try{Check(h,false);return new FileStream(h,write?FileAccess.ReadWrite:FileAccess.Read);}catch{h.Dispose();throw;}}
 static byte[] Bytes(FileStream f,int max){if(f.Length>max)Fail("FILE_TOO_LARGE");var data=new byte[(int)f.Length];int at=0;while(at<data.Length){int n=f.Read(data,at,data.Length-at);if(n==0)Fail("READ_FAILED");at+=n;}return data;}
 static void Bound(Pins pin,Dictionary<string,object> request,string field){object value;if(request.TryGetValue(field,out value)&&(!(value is string)||pin.Fingerprint!=(string)value))Fail("ROOT_CHANGED");}
 static void WriteNew(Pins pin,string relative,byte[] data){var file=Relative(pin.Root,relative);pin.Parent(file,true);using(var f=File(file,true,true)){f.Write(data,0,data.Length);f.Flush(true);}}
 static Dictionary<string,object> Inspect(Dictionary<string,object> request){using(var pin=new Pins(S(request,"root"),false)){var file=Relative(pin.Root,S(request,"path"));pin.Parent(file,false);using(var f=File(file,false,false)){var info=Check(f.SafeFileHandle,false);if(f.Length>512L*1024*1024)Fail("FILE_TOO_LARGE");var result=new Dictionary<string,object>{{"ok",true},{"rootFingerprint",pin.Fingerprint},{"fileFingerprint",Fingerprint(info)},{"webRootFingerprint",pin.WebRootFingerprint},{"webFileFingerprint",WebFingerprint(file,info)},{"sha256",Hash(f)},{"bytes",f.Length}};object text;if(request.TryGetValue("text",out text)&&text is bool&&(bool)text){f.Position=0;result.Add("text",new UTF8Encoding(false,true).GetString(Bytes(f,8*1024*1024)));}return result;}}}
 static object Copy(Dictionary<string,object> request) {
  string dest=S(request,"destination");
  using(var parent=new Pins(Path.GetDirectoryName(Full(dest)),true)) {
   Bound(parent,request,"destinationParentFingerprint");
   if(!CreateDirectory(dest,IntPtr.Zero))Fail("VERSION_ALREADY_EXISTS");
  using(var source=new Pins(S(request,"source"),false)) using(var target=new Pins(dest,false)) {
   Bound(source,request,"sourceFingerprint");
   var list=request["files"] as IList;
   if(list==null||list.Count==0||list.Count>20000)Fail("FILES_REJECTED");
   long total=0;var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
   foreach(var raw in list) {
    var item=raw as Dictionary<string,object>;if(item==null)Fail("FILES_REJECTED");
    string relative=S(item,"path"),expected=S(item,"sha256");long size=Convert.ToInt64(item["bytes"]);
    if(size<0||size>512L*1024*1024||(total+=size)>2L*1024*1024*1024||!System.Text.RegularExpressions.Regex.IsMatch(expected,"^[a-f0-9]{64}$")||!names.Add(relative))Fail("FILES_REJECTED");
    string from=Relative(source.Root,relative),to=Relative(target.Root,relative);
    source.Parent(from,false);target.Parent(to,true);
    using(var input=File(from,false,false)) using(var output=File(to,true,true)) {
     if(input.Length!=size)Fail("SOURCE_CHANGED");
     using(var h=SHA256.Create()) {
      var buffer=new byte[1024*1024];int n;
      while((n=input.Read(buffer,0,buffer.Length))>0){h.TransformBlock(buffer,0,n,null,0);output.Write(buffer,0,n);}
      h.TransformFinalBlock(new byte[0],0,0);if(Hex(h.Hash)!=expected)Fail("SOURCE_CHANGED");
     }
     output.Flush(true);
    }
   }
   return new {ok=true,rootFingerprint=target.Fingerprint,files=list.Count,bytes=total};
  }
  }
 }
 static object Verify(Dictionary<string,object> request) {
  using(var pin=new Pins(S(request,"root"),false)) {
   Bound(pin,request,"rootFingerprint");var files=request["files"] as IList;
   if(files==null||files.Count==0||files.Count>20000)Fail("FILES_REJECTED");
   foreach(var raw in files){var item=raw as Dictionary<string,object>;if(item==null)Fail("FILES_REJECTED");string file=Relative(pin.Root,S(item,"path"));pin.Parent(file,false);using(var f=File(file,false,false)){if(f.Length!=Convert.ToInt64(item["bytes"])||Hash(f)!=S(item,"sha256"))Fail("PACKAGE_FILE_CHANGED");}}
   return new{ok=true,rootFingerprint=pin.Fingerprint,files=files.Count};
  }
 }
 static object Materialize(Dictionary<string,object> request) {
  using(var pin=new Pins(S(request,"root"),false)) {
   Bound(pin,request,"rootFingerprint");var files=request["files"] as IList;
   if(files==null||files.Count==0||files.Count>20000)Fail("FILES_REJECTED");
   foreach(var raw in files){var item=raw as Dictionary<string,object>;if(item==null)Fail("FILES_REJECTED");var data=Convert.FromBase64String(S(item,"base64"));if(data.Length>4*1024*1024||Hash(data)!=S(item,"sha256"))Fail("SOURCE_CHANGED");WriteNew(pin,S(item,"path"),data);}
   return new{ok=true,rootFingerprint=pin.Fingerprint,files=files.Count};
  }
 }
 static object Write(Dictionary<string,object> request) {
  using(var pin=new Pins(S(request,"root"),true)) {
   Bound(pin,request,"rootFingerprint");
   string relative=S(request,"path"),file=Relative(pin.Root,relative);
   byte[] data=new UTF8Encoding(false,true).GetBytes(S(request,"text"));
   if(data.Length>1024*1024)Fail("TEXT_TOO_LARGE");pin.Parent(file,true);
   string expected=S(request,"expectedHash");
   if(expected=="missing"){WriteNew(pin,relative,data);return new{ok=true,sha256=Hash(data)};}
   string expectedId=S(request,"fileFingerprint");
   using(var f=File(file,true,false)) {
    var before=Bytes(f,1024*1024);
    if(Hash(before)!=expected||Fingerprint(Check(f.SafeFileHandle,false))!=expectedId)Fail("CURRENT_CHANGED");
    string id=Guid.NewGuid().ToString("N"),backup="history/current-"+id+".json",journal="history/change-"+id+".json";
    WriteNew(pin,backup,before);
    string receipt=json.Serialize(new{version=1,path=relative,backup=backup,beforeHash=expected,afterHash=Hash(data),fileFingerprint=expectedId});
    WriteNew(pin,journal,Encoding.UTF8.GetBytes(receipt));
    f.Position=0;f.SetLength(0);f.Write(data,0,data.Length);f.Flush(true);f.Position=0;
    if(Hash(f)!=Hash(data))Fail("PARTIAL_CURRENT_WRITE");
    return new{ok=true,sha256=Hash(data),backup=backup,journal=journal};
   }
  }
 }
 static object Rename(Dictionary<string,object> request) {
  using(var pin=new Pins(S(request,"root"),false)) {
   string source=Relative(pin.Root,S(request,"source")),destination=Relative(pin.Root,S(request,"destination"));
   if(String.Equals(source,destination,StringComparison.OrdinalIgnoreCase))Fail("PATH_REJECTED");
   pin.Parent(source,false);pin.Parent(destination,true);
   var sourceHandle=CreateFile(source,READ|DELETE,0,IntPtr.Zero,OPEN,OPEN_REPARSE,IntPtr.Zero);
   using(var input=new FileStream(sourceHandle,FileAccess.Read)) {
    var info=Check(sourceHandle,false);var data=Bytes(input,1024*1024);
    if(Fingerprint(info)!=S(request,"fileFingerprint")||Hash(data)!=S(request,"expectedHash"))Fail("CURRENT_CHANGED");
    var destinationHandle=CreateFile(destination,READ|WRITE|DELETE,0,IntPtr.Zero,CREATE_NEW,OPEN_REPARSE,IntPtr.Zero);
    if(destinationHandle.IsInvalid)Fail("OPEN_FAILED");
    using(var output=new FileStream(destinationHandle,FileAccess.ReadWrite)) {
     bool committed=false;
     try {
      Check(destinationHandle,false);output.Write(data,0,data.Length);output.Flush(true);
      int delete=1;if(!SetFileInformationByHandle(sourceHandle,4,ref delete,4))Fail("RENAME_FAILED");committed=true;
     } finally {
      if(!committed){int cleanup=1;SetFileInformationByHandle(destinationHandle,4,ref cleanup,4);}
     }
    }
   }
   return new{ok=true};
  }
 }
 static object ProcessAlive(Dictionary<string,object> request) {
  int pid;try{pid=Convert.ToInt32(request["pid"]);}catch{Fail("INPUT_REJECTED");return null;}
  long ticks=0;string tickText=S(request,"createdTicks");if(pid<=0||!Int64.TryParse(tickText,System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out ticks)||ticks<=0)Fail("INPUT_REJECTED");
  string expected=Full(S(request,"imagePath"));
  using(var process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,false,pid)) {
   if(process.IsInvalid){if(Marshal.GetLastWin32Error()==5)return new{ok=true,alive=true};return new{ok=true,alive=false};}
   System.Runtime.InteropServices.ComTypes.FILETIME created,exited,kernel,user;
   if(!GetProcessTimes(process,out created,out exited,out kernel,out user)){if(Marshal.GetLastWin32Error()==5)return new{ok=true,alive=true};return new{ok=true,alive=false};}
   long fileTime=((long)(uint)created.dwHighDateTime<<32)|(uint)created.dwLowDateTime;
   var image=new StringBuilder(32768);int size=image.Capacity;
   if(!QueryFullProcessImageNameW(process,0,image,ref size)){if(Marshal.GetLastWin32Error()==5)return new{ok=true,alive=true};return new{ok=true,alive=false};}
   bool alive=DateTime.FromFileTimeUtc(fileTime).Ticks==ticks&&String.Equals(image.ToString(),expected,StringComparison.OrdinalIgnoreCase);
   return new{ok=true,alive=alive};
  }
 }
 static object Init(Dictionary<string,object> request){using(var pin=new Pins(S(request,"root"),true)){foreach(var name in new[]{"_hub/placeholder","Product/placeholder","Work/placeholder"})pin.Parent(Relative(pin.Root,name),true);return new{ok=true,rootFingerprint=pin.Fingerprint};}}
 static object Remove(Dictionary<string,object> request){using(var pin=new Pins(S(request,"root"),false)){var file=Relative(pin.Root,S(request,"path"));pin.Parent(file,false);var h=CreateFile(file,READ|0x10000,0,IntPtr.Zero,OPEN,OPEN_REPARSE,IntPtr.Zero);using(var f=new FileStream(h,FileAccess.Read)){var info=Check(h,false);if(Fingerprint(info)!=S(request,"fileFingerprint")||Hash(f)!=S(request,"expectedHash"))Fail("CURRENT_CHANGED");int delete=1;if(!SetFileInformationByHandle(h,4,ref delete,4))Fail("REMOVE_FAILED");}return new{ok=true};}}
 static object Identity(Dictionary<string,object> request){object create;using(var pin=new Pins(S(request,"root"),request.TryGetValue("create",out create)&&create is bool&&(bool)create)){Bound(pin,request,"rootFingerprint");return new{ok=true,rootFingerprint=pin.Fingerprint,webRootFingerprint=pin.WebRootFingerprint};}}
 static object Port(Dictionary<string,object> request,bool free){int port=free?0:Convert.ToInt32(request["port"]);if(!free&&(port<1024||port>65535))Fail("PORT_REJECTED");var listener=new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback,port);try{listener.Start();return new{ok=true,port=((System.Net.IPEndPoint)listener.LocalEndpoint).Port};}catch(System.Net.Sockets.SocketException){Fail("PORT_IN_USE");return null;}finally{listener.Stop();}}
 static int Main(){Console.InputEncoding=new UTF8Encoding(false,true);Console.OutputEncoding=new UTF8Encoding(false);try{var input=Console.In.ReadToEnd();if(input.Length>8*1024*1024)Fail("REQUEST_TOO_LARGE");var request=json.Deserialize<Dictionary<string,object>>(input);var mode=S(request,"mode");object result=null;if(mode=="package-context")result=PackageContext();else if(mode=="inspect")result=Inspect(request);else if(mode=="copy")result=Copy(request);else if(mode=="write")result=Write(request);else if(mode=="rename")result=Rename(request);else if(mode=="process-alive")result=ProcessAlive(request);else if(mode=="init")result=Init(request);else if(mode=="remove")result=Remove(request);else if(mode=="identity")result=Identity(request);else if(mode=="verify")result=Verify(request);else if(mode=="materialize")result=Materialize(request);else if(mode=="port-check")result=Port(request,false);else if(mode=="free-port")result=Port(request,true);else Fail("MODE_REJECTED");Console.Write(json.Serialize(result));return 0;}catch(Exception e){string code=e is InvalidOperationException?e.Message:"INSTALL_OPERATION_FAILED";Console.Write(json.Serialize(new{ok=false,code=code}));return 1;}}
}
