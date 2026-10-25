// Windows 26200 native AMD64 only. Relative NT opens keep every directory
// handle alive, reject reparses and deny delete sharing through the operation.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Globalization;
using System.Web.Script.Serialization;

class ScopedFile {
  const uint READ_DATA=1, WRITE_DATA=2, READ_ATTR=0x80, DELETE=0x10000, SYNC=0x100000;
  const uint DIRECTORY=1, NON_DIRECTORY=0x40, SYNCHRONOUS=0x20, OPEN_REPARSE=0x200000, COMPLETE_OPLOCK=0x100;
  const uint SHARE_READ=1, SHARE_WRITE=2, CREATE=2, OPEN=1, OPEN_IF=3;
  const uint REPARSE=0x400, DIR_ATTR=0x10, NORMAL=0x80;
  const int MAX_BYTES=200*1024;
  [StructLayout(LayoutKind.Sequential)] struct UNICODE_STRING { public ushort Length,MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct OBJECT_ATTRIBUTES { public uint Length; public IntPtr RootDirectory,ObjectName; public uint Attributes; public IntPtr SecurityDescriptor,SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK { public IntPtr Status; public UIntPtr Information; }
  [StructLayout(LayoutKind.Sequential)] struct ATTRIBUTE_TAG { public uint Attributes,Tag; }
  [StructLayout(LayoutKind.Sequential)] struct FILE_TIME { public uint Low,High; }
  [StructLayout(LayoutKind.Sequential)] struct FILE_INFO { public uint Attributes; public FILE_TIME Creation,Access,Write; public uint VolumeSerial,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct VERSION_INFO { public uint Size,Major,Minor,Build,Platform; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string ServicePack; }
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr file,uint access,ref OBJECT_ATTRIBUTES attributes,out IO_STATUS_BLOCK io,IntPtr allocation,uint fileAttributes,uint sharing,uint disposition,uint options,IntPtr ea,uint eaLength);
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(IntPtr file,out IO_STATUS_BLOCK io,IntPtr information,uint length,int kind);
  [DllImport("ntdll.dll")] static extern int NtQueryDirectoryFile(IntPtr file,IntPtr ev,IntPtr routine,IntPtr context,out IO_STATUS_BLOCK io,IntPtr information,uint length,int kind,byte single,IntPtr name,byte restart);
  [DllImport("ntdll.dll",CharSet=CharSet.Unicode)] static extern int RtlGetVersion(ref VERSION_INFO version);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsWow64Process2(IntPtr process,out ushort processMachine,out ushort nativeMachine);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint sharing,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr file,StringBuilder name,uint length,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformationByHandleW(IntPtr file,StringBuilder volume,uint volumeLength,out uint serial,out uint component,out uint flags,StringBuilder filesystem,uint filesystemLength);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr file,int kind,out ATTRIBUTE_TAG info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out FILE_INFO info);
  [DllImport("kernel32.dll")] static extern uint GetFileType(IntPtr file);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileSizeEx(IntPtr file,out long size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr file,byte[] bytes,uint length,out uint read,IntPtr overlapped);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr file,byte[] bytes,uint length,out uint written,IntPtr overlapped);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(IntPtr file,long distance,out long pointer,uint method);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetEndOfFile(IntPtr file);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(IntPtr file);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr file);
  class Rejected : Exception { public string Code; public int Status; public Rejected(string code,int status=409) { Code=code;Status=status; } }
  static void Require(bool ok,string code,int status=409) { if(!ok)throw new Rejected(code,status); }
  static void Supported() {
    VERSION_INFO v=new VERSION_INFO();v.Size=(uint)Marshal.SizeOf(typeof(VERSION_INFO));
    ushort processMachine,nativeMachine;
    Require(IntPtr.Size==8 && RtlGetVersion(ref v)==0 && v.Major==10 && v.Minor==0 && v.Build==26200 &&
      IsWow64Process2(GetCurrentProcess(),out processMachine,out nativeMachine) && processMachine==0 && nativeMachine==0x8664,"UNSUPPORTED_PLATFORM");
    Require(Marshal.SizeOf(typeof(UNICODE_STRING))==16 && Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES))==48 && Marshal.SizeOf(typeof(IO_STATUS_BLOCK))==16,"UNSUPPORTED_ABI");
  }
  static bool ValidComponent(string name) {
    if(String.IsNullOrEmpty(name)||name.Length>255||name=="."||name==".."||name.EndsWith(".")||name.EndsWith(" "))return false;
    foreach(char c in name)if(c<32||c==127||"\\/:*?\"<>|".IndexOf(c)>=0)return false;
    string stem=name.Split('.')[0].ToUpperInvariant();
    if(stem=="CON"||stem=="PRN"||stem=="AUX"||stem=="NUL")return false;
    if(stem.Length==4&&(stem.StartsWith("COM")||stem.StartsWith("LPT"))&&"123456789¹²³".IndexOf(stem[3])>=0)return false;
    return true;
  }
  static string[] Parts(string relative,bool empty) {
    Require(relative!=null && relative.Length<=32768,"INVALID_PATH",403);
    if(relative==""&&empty)return new string[0];
    string[] parts=relative.Replace('/','\\').Split('\\');Require(parts.Length<=128,"PATH_DEPTH_LIMIT",403);foreach(string part in parts)Require(ValidComponent(part),"INVALID_PATH",403);return parts;
  }
  static string NormalRoot(string root) {
    Require(root!=null && root.Length>=3 && root.Length<=32768 && Char.IsLetter(root[0]) && root[1]==':' && (root[2]=='\\'||root[2]=='/'),"INVALID_ROOT",403);
    string normal=root.Replace('/','\\').TrimEnd('\\');
    if(normal.Length==2)normal+="\\";
    Require(normal.Length>3,"ROOT_REQUIRED",403);
    Parts(normal.Length<=3?"":normal.Substring(3),true);
    Require(GetDriveTypeW(normal.Substring(0,3))==3,"NONLOCAL_DRIVE",403);return normal;
  }
  static string FinalName(IntPtr file) {
    StringBuilder b=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(file,b,(uint)b.Capacity,0);
    Require(n>0&&n<b.Capacity,"FINAL_PATH_UNAVAILABLE");string result=b.ToString();
    Require(result.StartsWith("\\\\?\\")&&!result.StartsWith("\\\\?\\UNC\\",StringComparison.OrdinalIgnoreCase),"NONLOCAL_PATH",403);
    result=result.Substring(4);if(result.Length>3)result=result.TrimEnd('\\');return result;
  }
  static void Check(IntPtr file,string expected,bool directory,string root,bool allowSourceLinks=false) {
    ATTRIBUTE_TAG tag=new ATTRIBUTE_TAG();Require(GetFileType(file)==1&&GetFileInformationByHandleEx(file,9,out tag,8),"INVALID_FILE_TYPE",415);
    Require((tag.Attributes&REPARSE)==0,"REPARSE_REJECTED",403);
    Require(((tag.Attributes&DIR_ATTR)!=0)==directory,"INVALID_FILE_TYPE",415);
    string actual=FinalName(file);Require(String.Equals(actual,expected,StringComparison.OrdinalIgnoreCase),"PATH_CHANGED",403);
    if(root!=null)Require(String.Equals(actual,root,StringComparison.OrdinalIgnoreCase)||actual.StartsWith(root.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase),"OUTSIDE_ROOT",403);
    if(!directory){FILE_INFO info;Require(GetFileInformationByHandle(file,out info)&&(allowSourceLinks?info.Links>=1:info.Links==1),"MULTIPLE_LINKS_REJECTED",403);}
  }
  static IntPtr OpenRelative(IntPtr parent,string name,uint access,uint disposition,uint options,out int status,bool denyWrite=false) {
    IntPtr text=Marshal.StringToHGlobalUni(name),unicode=IntPtr.Zero;IntPtr file=IntPtr.Zero;
    try {
      UNICODE_STRING u=new UNICODE_STRING();u.Buffer=text;u.Length=(ushort)(name.Length*2);u.MaximumLength=(ushort)(u.Length+2);
      unicode=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));Marshal.StructureToPtr(u,unicode,false);
      OBJECT_ATTRIBUTES a=new OBJECT_ATTRIBUTES();a.Length=48;a.RootDirectory=parent;a.ObjectName=unicode;a.Attributes=0x40|0x1000;
      IO_STATUS_BLOCK io;status=NtCreateFile(out file,access|READ_ATTR|SYNC,ref a,out io,IntPtr.Zero,NORMAL,SHARE_READ|(!denyWrite&&(options&DIRECTORY)!=0?SHARE_WRITE:0),disposition,options|SYNCHRONOUS|OPEN_REPARSE|COMPLETE_OPLOCK,IntPtr.Zero,0);
      if(status!=0){if(file!=IntPtr.Zero&&file!=new IntPtr(-1))CloseHandle(file);return IntPtr.Zero;}return file;
    } finally { if(unicode!=IntPtr.Zero)Marshal.FreeHGlobal(unicode);Marshal.FreeHGlobal(text); }
  }
  static void Status(int status) {
    if(status==0)return;
    uint s=unchecked((uint)status);
    if(s==0xC0000034||s==0xC000003A)throw new Rejected("NOT_FOUND",404);
    if(s==0xC0000035)throw new Rejected("DESTINATION_EXISTS",409);
    if(s==0xC000050B||s==0xC0000275||s==0xC0000280)throw new Rejected("REPARSE_REJECTED",403);
    if(s==0xC0000022)throw new Rejected("ACCESS_DENIED",403);
    throw new Rejected("NT_OPERATION_REJECTED_"+s.ToString("X8"));
  }
  class Chain : IDisposable {
    public List<IntPtr> Handles=new List<IntPtr>();public string Root,Current;public bool DenyWrite;
    public IntPtr Last { get { return Handles[Handles.Count-1]; } }
    public Chain(string root,bool listRoot,bool denyWrite=false) {
      DenyWrite=denyWrite;
      Root=NormalRoot(root);Current=Root.Substring(0,3);
      IntPtr drive=CreateFileW(Current,READ_ATTR|SYNC|0x20,SHARE_READ|(denyWrite?0:SHARE_WRITE),IntPtr.Zero,3,0x02000000|0x00200000,IntPtr.Zero);
      Require(drive!=IntPtr.Zero&&drive!=new IntPtr(-1),"ROOT_OPEN_FAILED");Handles.Add(drive);
      try {Check(drive,Current,true,null);StringBuilder volume=new StringBuilder(260),filesystem=new StringBuilder(32);uint serial,component,flags;Require(GetVolumeInformationByHandleW(drive,volume,260,out serial,out component,out flags,filesystem,32)&&filesystem.ToString()=="NTFS","UNSUPPORTED_FILESYSTEM");string[] parts=Parts(Root.Length<=3?"":Root.Substring(3),true);for(int i=0;i<parts.Length;i++)Next(parts[i],false,listRoot&&i==parts.Length-1);Check(Last,Root,true,Root);}
      catch {Dispose();throw;}
    }
    public void Next(string part,bool create,bool list=false) {
      Require(ValidComponent(part),"INVALID_PATH",403);int status;
      IntPtr handle=OpenRelative(Last,part,(list?READ_DATA:0)|0x20,OPEN,DIRECTORY,out status,DenyWrite);
      if(create&&unchecked((uint)status)==0xC0000034)handle=OpenRelative(Last,part,(list?READ_DATA:0)|0x20,CREATE,DIRECTORY,out status,DenyWrite);
      Status(status);Handles.Add(handle);
      Current=Current.TrimEnd('\\')+"\\"+part;Check(handle,Current,true,null);
    }
    public void Verify() {Check(Last,Current,true,Root);}
    public string Fingerprint() {FILE_INFO info;Require(GetFileInformationByHandle(Last,out info),"ROOT_ID_UNAVAILABLE");ulong index=((ulong)info.IndexHigh<<32)|info.IndexLow;return Hash(Encoding.UTF8.GetBytes(Root+"\n"+info.VolumeSerial.ToString(CultureInfo.InvariantCulture)+"\n"+index.ToString(CultureInfo.InvariantCulture)));}
    public void Dispose() {for(int i=Handles.Count-1;i>=0;i--)CloseHandle(Handles[i]);Handles.Clear();}
  }
  static string Hash(byte[] bytes) {using(SHA256 sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
  static string FileFingerprint(IntPtr handle,string fullPath) {FILE_INFO info;Require(GetFileInformationByHandle(handle,out info),"FILE_ID_UNAVAILABLE");ulong index=((ulong)info.IndexHigh<<32)|info.IndexLow;return Hash(Encoding.UTF8.GetBytes(fullPath+"\n"+info.VolumeSerial.ToString(CultureInfo.InvariantCulture)+"\n"+index.ToString(CultureInfo.InvariantCulture)));}
  static bool Digest(string value){if(value==null||value.Length!=64)return false;foreach(char c in value)if("0123456789abcdef".IndexOf(c)<0)return false;return true;}
  static IntPtr OpenFile(Chain chain,string[] parts,uint access,bool allowSourceLinks=false) {Require(parts.Length>0,"FILE_REQUIRED",400);for(int i=0;i<parts.Length-1;i++)chain.Next(parts[i],false);chain.Verify();int status;IntPtr file=OpenRelative(chain.Last,parts[parts.Length-1],access,OPEN,NON_DIRECTORY,out status);Status(status);try{Check(file,chain.Current.TrimEnd('\\')+"\\"+parts[parts.Length-1],false,chain.Root,allowSourceLinks);return file;}catch{CloseHandle(file);throw;}}
  static byte[] Bytes(IntPtr file,int max) {long size;Require(GetFileSizeEx(file,out size)&&size>=0&&size<=max,"FILE_SIZE_REJECTED",415);byte[] bytes=new byte[(int)size];uint read;Require(ReadFile(file,bytes,(uint)bytes.Length,out read,IntPtr.Zero)&&read==bytes.Length,"READ_INCOMPLETE");return bytes;}
  static Dictionary<string,object> Read(Chain chain,string[] parts) {
    for(int i=0;i<parts.Length-1;i++)chain.Next(parts[i],false);
    IntPtr handle=chain.Last;bool owned=false,directory=true;
    try {
      if(parts.Length>0){int status;handle=OpenRelative(chain.Last,parts[parts.Length-1],READ_DATA,OPEN,0,out status);Status(status);owned=true;ATTRIBUTE_TAG tag;Require(GetFileInformationByHandleEx(handle,9,out tag,8),"FILE_TYPE_UNAVAILABLE");directory=(tag.Attributes&DIR_ATTR)!=0;}
      string expected=parts.Length==0?chain.Current:chain.Current.TrimEnd('\\')+"\\"+parts[parts.Length-1];Check(handle,expected,directory,chain.Root);chain.Verify();
      if(directory){Dictionary<string,object> listing=List(handle);listing["kind"]="directory";return listing;}
      long size;Require(GetFileSizeEx(handle,out size)&&size>=0,"FILE_SIZE_UNAVAILABLE");int count=(int)Math.Min(size,MAX_BYTES);byte[] bytes=new byte[count];uint read;
      Require(ReadFile(handle,bytes,(uint)count,out read,IntPtr.Zero)&&read==count,"READ_INCOMPLETE");
      foreach(byte b in bytes)Require(b!=0,"BINARY_REJECTED",415);
      string text;
      try {Decoder decoder=new UTF8Encoding(false,true).GetDecoder();char[] chars=new char[count];int usedBytes,usedChars;bool completed;decoder.Convert(bytes,0,bytes.Length,chars,0,chars.Length,size<=MAX_BYTES,out usedBytes,out usedChars,out completed);text=new string(chars,0,usedChars);}
      catch(DecoderFallbackException){throw new Rejected("ENCODING_REJECTED",415);}
      Check(handle,expected,false,chain.Root);chain.Verify();
      return new Dictionary<string,object>{{"kind","file"},{"text",text},{"size",size},{"bytesRead",count},{"truncated",size>MAX_BYTES},{"sha256",size<=MAX_BYTES?Hash(bytes):null}};
    } finally {if(owned&&handle!=IntPtr.Zero)CloseHandle(handle);}
  }
  static Dictionary<string,object> List(IntPtr directory) {
    IntPtr buffer=Marshal.AllocHGlobal(65536);List<string> entries=new List<string>();bool first=true;
    try {while(entries.Count<500){IO_STATUS_BLOCK io;int status=NtQueryDirectoryFile(directory,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,out io,buffer,65536,1,0,IntPtr.Zero,first?(byte)1:(byte)0);first=false;if(unchecked((uint)status)==0x80000006)break;Status(status);
      int offset=0,length=checked((int)io.Information.ToUInt64());Require(length<=65536,"DIRECTORY_BUFFER_INVALID");
      while(offset<length){Require(offset+64<=length,"DIRECTORY_BUFFER_INVALID");int next=Marshal.ReadInt32(buffer,offset),attributes=Marshal.ReadInt32(buffer,offset+56),nameLength=Marshal.ReadInt32(buffer,offset+60);Require(nameLength>=0&&(nameLength&1)==0&&offset+64+nameLength<=length,"DIRECTORY_BUFFER_INVALID");string name=Marshal.PtrToStringUni(IntPtr.Add(buffer,offset+64),nameLength/2);if(name!="."&&name!=".."){Require(ValidComponent(name),"DIRECTORY_NAME_INVALID",403);entries.Add(name+((attributes&DIR_ATTR)!=0?"/":""));if(entries.Count>=500)break;}if(next==0)break;Require(next>=64&&offset+next<=length,"DIRECTORY_BUFFER_INVALID");offset+=next;}
    }entries.Sort(StringComparer.Ordinal);return new Dictionary<string,object>{{"entries",entries.ToArray()},{"limit",500},{"truncated",entries.Count>=500}};}finally{Marshal.FreeHGlobal(buffer);}
  }
  static void DeleteTemp(IntPtr handle) {IntPtr buffer=Marshal.AllocHGlobal(1);try{Marshal.WriteByte(buffer,1);IO_STATUS_BLOCK io;int status=NtSetInformationFile(handle,out io,buffer,1,13);if(status!=0)throw new Rejected("TEMP_CLEANUP_FAILED");}finally{Marshal.FreeHGlobal(buffer);}}
  static void Rename(IntPtr temp,IntPtr parent,string name) {
    byte[] bytes=Encoding.Unicode.GetBytes(name);int size=Math.Max(24,20+bytes.Length);IntPtr buffer=Marshal.AllocHGlobal(size);
    try {for(int i=0;i<size;i++)Marshal.WriteByte(buffer,i,0);Marshal.WriteIntPtr(buffer,8,parent);Marshal.WriteInt32(buffer,16,bytes.Length);Marshal.Copy(bytes,0,IntPtr.Add(buffer,20),bytes.Length);IO_STATUS_BLOCK io;int status=NtSetInformationFile(temp,out io,buffer,(uint)size,10);if(status!=0)throw new Rejected("RENAME_REJECTED_"+unchecked((uint)status).ToString("X8"));}
    finally{Marshal.FreeHGlobal(buffer);}
  }
  static Dictionary<string,object> CreateBytes(Chain chain,string[] parts,byte[] bytes,string tempSuffix=".tmp") {
    Require(parts.Length>0,"FILE_REQUIRED",400);
    for(int i=0;i<parts.Length-1;i++)chain.Next(parts[i],true);chain.Verify();
    string final=parts[parts.Length-1];int status;IntPtr existing=OpenRelative(chain.Last,final,0,OPEN,0,out status);
    if(status==0){try{ATTRIBUTE_TAG tag;Require(GetFileInformationByHandleEx(existing,9,out tag,8),"FILE_TYPE_UNAVAILABLE");Require((tag.Attributes&REPARSE)==0,"REPARSE_REJECTED",403);}finally{CloseHandle(existing);}throw new Rejected("DESTINATION_EXISTS");}
    if(unchecked((uint)status)!=0xC0000034)Status(status);
    string name=".hub-write-"+Guid.NewGuid().ToString("N")+tempSuffix;IntPtr temp=OpenRelative(chain.Last,name,WRITE_DATA|DELETE,CREATE,NON_DIRECTORY|2,out status);Status(status);bool moved=false;
    try{string tempPath=chain.Current.TrimEnd('\\')+"\\"+name;Check(temp,tempPath,false,chain.Root);uint written;Require(WriteFile(temp,bytes,(uint)bytes.Length,out written,IntPtr.Zero)&&written==bytes.Length&&FlushFileBuffers(temp),"WRITE_INCOMPLETE");chain.Verify();Check(temp,tempPath,false,chain.Root);Rename(temp,chain.Last,final);moved=true;string finalPath=chain.Current.TrimEnd('\\')+"\\"+final;Check(temp,finalPath,false,chain.Root);return new Dictionary<string,object>{{"bytes",bytes.Length},{"sha256",Hash(bytes)},{"fileFingerprint",FileFingerprint(temp,finalPath)},{"created",true}};}
    finally{try{if(!moved)DeleteTemp(temp);}finally{CloseHandle(temp);}}
  }
  static Dictionary<string,object> Create(Chain chain,string[] parts,string text,string expectedHash) {
    Require(parts.Length>0&&text!=null&&expectedHash=="missing","OVERWRITE_NOT_SUPPORTED",409);byte[] bytes;
    try{bytes=new UTF8Encoding(false,true).GetBytes(text);}catch(EncoderFallbackException){throw new Rejected("ENCODING_REJECTED",415);}
    Require(bytes.Length<=MAX_BYTES&&Array.IndexOf(bytes,(byte)0)<0,"CONTENT_REJECTED",415);return CreateBytes(chain,parts,bytes);
  }
  static void Exact(Dictionary<string,object> request,string[] allowed){Require(request.Count==allowed.Length,"INVALID_REQUEST",400);foreach(string key in allowed)Require(request.ContainsKey(key),"INVALID_REQUEST",400);}
  static Dictionary<string,object> Private(Dictionary<string,object> request,string mode){
    bool artifact=mode.StartsWith("private-artifact-"),binary=mode.StartsWith("private-binary-"),copy=mode.EndsWith("-copy"),remove=mode.EndsWith("-remove");int max=binary?512*1024*1024:artifact?64*1024*1024:8*1024*1024;
    if(copy)Exact(request,request.ContainsKey("sourceFingerprint")?new string[]{"mode","root","rootFingerprint","path","sourceRoot","sourceRootFingerprint","sourcePath","sourceHash","sourceFingerprint"}:new string[]{"mode","root","rootFingerprint","path","sourceRoot","sourceRootFingerprint","sourcePath","sourceHash"});
    else if(!remove)Exact(request,new string[]{"mode","root","rootFingerprint","path"});
    else Exact(request,new string[]{"mode","root","rootFingerprint","path","expectedHash","expectedFingerprint"});
    string root=request["root"]as string;string[] parts=Parts(request["path"]as string,false);
    using(Chain chain=new Chain(root,false)){
      Require(request["rootFingerprint"]as string==chain.Fingerprint(),"ROOT_CHANGED",403);
      if(copy){
        Require(Digest(request["sourceHash"]as string),"INVALID_HASH",400);
        using(Chain source=new Chain(request["sourceRoot"]as string,false)){
          Require(request["sourceRootFingerprint"]as string==source.Fingerprint(),"SOURCE_ROOT_CHANGED",403);
          string[] sourceParts=Parts(request["sourcePath"]as string,false);IntPtr file=OpenFile(source,sourceParts,READ_DATA,binary);
          try{if(request.ContainsKey("sourceFingerprint")){Require(Digest(request["sourceFingerprint"]as string),"INVALID_BINDING",400);string sourcePath=source.Current.TrimEnd('\\')+"\\"+sourceParts[sourceParts.Length-1];Require(FileFingerprint(file,sourcePath)==request["sourceFingerprint"]as string,"SOURCE_FILE_CHANGED");}byte[] bytes=Bytes(file,max);Require(Hash(bytes)==request["sourceHash"]as string,"SOURCE_HASH_CHANGED");source.Verify();return CreateBytes(chain,parts,bytes,".key");}finally{CloseHandle(file);}
        }
      }
      IntPtr target=OpenFile(chain,parts,READ_DATA|(remove?DELETE:0));
      try{
        byte[] bytes=Bytes(target,max);string fullPath=chain.Current.TrimEnd('\\')+"\\"+parts[parts.Length-1],hash=Hash(bytes),fingerprint=FileFingerprint(target,fullPath);chain.Verify();
        if(remove){Require(Digest(request["expectedHash"]as string)&&Digest(request["expectedFingerprint"]as string),"INVALID_BINDING",400);Require(hash==request["expectedHash"]as string&&fingerprint==request["expectedFingerprint"]as string,"FILE_CHANGED");DeleteTemp(target);return new Dictionary<string,object>{{"removed",true},{"sha256",hash},{"fileFingerprint",fingerprint}};}
        return new Dictionary<string,object>{{"sha256",hash},{"fileFingerprint",fingerprint},{"bytes",bytes.Length}};
      }finally{CloseHandle(target);}
    }
  }
  static byte[] TextBytes(string text){Require(text!=null,"INVALID_CONTENT",400);byte[] bytes;try{bytes=new UTF8Encoding(false,true).GetBytes(text);}catch(EncoderFallbackException){throw new Rejected("ENCODING_REJECTED",415);}Require(bytes.Length<=MAX_BYTES&&Array.IndexOf(bytes,(byte)0)<0,"CONTENT_REJECTED",415);return bytes;}
  static void TextCheck(byte[] bytes){Require(Array.IndexOf(bytes,(byte)0)<0,"BINARY_REJECTED",415);try{new UTF8Encoding(false,true).GetString(bytes);}catch(DecoderFallbackException){throw new Rejected("ENCODING_REJECTED",415);}}
  static void WriteExisting(IntPtr file,byte[] bytes){long position;Require(SetFilePointerEx(file,0,out position,0)&&position==0,"WRITE_SEEK_FAILED");uint written;Require(WriteFile(file,bytes,(uint)bytes.Length,out written,IntPtr.Zero)&&written==bytes.Length,"WRITE_INCOMPLETE");Require(SetEndOfFile(file)&&FlushFileBuffers(file),"WRITE_INCOMPLETE");Require(SetFilePointerEx(file,0,out position,0)&&position==0,"VERIFY_SEEK_FAILED");Require(Hash(Bytes(file,MAX_BYTES))==Hash(bytes),"WRITE_VERIFY_FAILED");}
  static string JournalPath(string id,string name){return id+"/"+name;}
  static void JournalCreate(Chain journal,string id,string name,byte[] bytes){using(Chain writer=new Chain(journal.Root,false,true)){Require(writer.Fingerprint()==journal.Fingerprint(),"JOURNAL_ROOT_CHANGED",403);writer.Next(id,true);int status;IntPtr file=OpenRelative(writer.Last,name,WRITE_DATA|DELETE,CREATE,NON_DIRECTORY,out status);Status(status);bool completed=false;try{string full=writer.Current+"\\"+name;Check(file,full,false,writer.Root);uint written;Require(WriteFile(file,bytes,(uint)bytes.Length,out written,IntPtr.Zero)&&written==bytes.Length&&FlushFileBuffers(file),"JOURNAL_WRITE_INCOMPLETE");writer.Verify();Check(file,full,false,writer.Root);completed=true;}finally{try{if(!completed)DeleteTemp(file);}finally{CloseHandle(file);}}}}
  static Dictionary<string,object> JournalRead(Chain journal,string id,string name){using(Chain reader=new Chain(journal.Root,false,true)){Require(reader.Fingerprint()==journal.Fingerprint(),"JOURNAL_ROOT_CHANGED",403);IntPtr file=OpenFile(reader,Parts(JournalPath(id,name),false),READ_DATA);try{byte[] bytes=Bytes(file,MAX_BYTES);TextCheck(bytes);Dictionary<string,object> result=new JavaScriptSerializer().DeserializeObject(Encoding.UTF8.GetString(bytes))as Dictionary<string,object>;Require(result!=null,"JOURNAL_INVALID");return result;}finally{CloseHandle(file);}}}
  static byte[] JournalBytes(Chain journal,string id,string name,int max=MAX_BYTES){using(Chain reader=new Chain(journal.Root,false,true)){Require(reader.Fingerprint()==journal.Fingerprint(),"JOURNAL_ROOT_CHANGED",403);IntPtr file=OpenFile(reader,Parts(JournalPath(id,name),false),READ_DATA);try{return Bytes(file,max);}finally{CloseHandle(file);}}}
  static Dictionary<string,object> Overwrite(Dictionary<string,object> request,bool recovery,bool privateConfig=false){
    if(privateConfig)Exact(request,recovery?new string[]{"mode","root","rootFingerprint","path","expectedHash","expectedFingerprint","recordId","journalRoot","journalRootFingerprint"}:new string[]{"mode","root","rootFingerprint","path","text","expectedHash","expectedFingerprint","journalRoot","journalRootFingerprint"});
    else if(!recovery)Exact(request,new string[]{"mode","root","rootFingerprint","path","text","expectedHash","journalRoot","journalRootFingerprint"});
    else Exact(request,new string[]{"mode","root","rootFingerprint","path","expectedHash","recordId","journalRoot","journalRootFingerprint"});
    string[] parts=Parts(request["path"]as string,false);string root=request["root"]as string,journalRoot=request["journalRoot"]as string;Require(Digest(request["expectedHash"]as string),"INVALID_HASH",400);
    if(privateConfig)Require(parts.Length>0&&parts[parts.Length-1]=="config.toml"&&Digest(request["expectedFingerprint"]as string),"INVALID_CONFIG_BINDING",400);
    using(Chain chain=new Chain(root,false,true))using(Chain journal=new Chain(journalRoot,false,true)){
      Require(request["rootFingerprint"]as string==chain.Fingerprint(),"ROOT_CHANGED",403);Require(request["journalRootFingerprint"]as string==journal.Fingerprint(),"JOURNAL_ROOT_CHANGED",403);
      Require(!journal.Root.Equals(chain.Root,StringComparison.OrdinalIgnoreCase)&&!journal.Root.StartsWith(chain.Root+"\\",StringComparison.OrdinalIgnoreCase),"JOURNAL_IN_TASK_REJECTED",403);
      IntPtr file=OpenFile(chain,parts,READ_DATA|WRITE_DATA);
      try {
        byte[] before=Bytes(file,MAX_BYTES);string beforeHash=Hash(before),targetPath=chain.Current.TrimEnd('\\')+"\\"+parts[parts.Length-1],fileId=FileFingerprint(file,targetPath);Require(beforeHash==request["expectedHash"]as string,"HASH_CHANGED");if(privateConfig)Require(fileId==request["expectedFingerprint"]as string,"FILE_CHANGED");
        if(recovery){
          string id=request["recordId"]as string;Guid parsed;Require(Guid.TryParseExact(id,"N",out parsed),"INVALID_RECORD",400);
          Dictionary<string,object> prepared=JournalRead(journal,id,"prepared.json");Exact(prepared,new string[]{"version","recordId","root","rootFingerprint","path","fileFingerprint","beforeHash","afterHash","state"});
          Require(prepared["version"]is int&&(int)prepared["version"]==(privateConfig?2:1)&&prepared["recordId"]as string==id&&prepared["root"]as string==chain.Root&&prepared["rootFingerprint"]as string==request["rootFingerprint"]as string&&prepared["path"]as string==request["path"]as string&&prepared["fileFingerprint"]as string==fileId&&prepared["state"]as string=="prepared"&&Digest(prepared["beforeHash"]as string)&&Digest(prepared["afterHash"]as string),"RECOVERY_BINDING_CHANGED");
          // A completed or previously restored transaction cannot be applied twice.
          using(Chain check=new Chain(journal.Root,false,true)){check.Next(id,false);foreach(string receiptName in new string[]{"complete.json","recovered.json"}){int status;IntPtr existing=OpenRelative(check.Last,receiptName,READ_DATA,OPEN,NON_DIRECTORY,out status);if(status==0){CloseHandle(existing);throw new Rejected("RECORD_COMPLETE");}if(unchecked((uint)status)!=0xC0000034)Status(status);}}
          byte[] backup=JournalBytes(journal,id,privateConfig?"before.dpapi":"before.bin",privateConfig?MAX_BYTES+16384:MAX_BYTES);if(privateConfig)backup=ProtectedData.Unprotect(backup,Encoding.UTF8.GetBytes("ProjectHub.McpConfigBackup.v1"),DataProtectionScope.CurrentUser);TextCheck(backup);Require(Hash(backup)==prepared["beforeHash"]as string,"BACKUP_CHANGED");
          try{WriteExisting(file,backup);chain.Verify();Dictionary<string,object> receipt=new Dictionary<string,object>{{"recordId",id},{"state","recovered"},{"sha256",Hash(backup)}};JournalCreate(journal,id,"recovered.json",Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(receipt)));return new Dictionary<string,object>{{"recovered",true},{"recordId",id},{"beforeHash",beforeHash},{"sha256",Hash(backup)},{"fileFingerprint",fileId}};}
          catch{throw new Rejected("RECOVERY_REQUIRED_"+id,409);}
        }
        TextCheck(before);byte[] after=TextBytes(request["text"]as string);string recordId=Guid.NewGuid().ToString("N"),afterHash=Hash(after);
        Dictionary<string,object> record=new Dictionary<string,object>{{"version",privateConfig?2:1},{"recordId",recordId},{"root",chain.Root},{"rootFingerprint",request["rootFingerprint"]},{"path",request["path"]},{"fileFingerprint",fileId},{"beforeHash",beforeHash},{"afterHash",afterHash},{"state","prepared"}};
        JournalCreate(journal,recordId,privateConfig?"before.dpapi":"before.bin",privateConfig?ProtectedData.Protect(before,Encoding.UTF8.GetBytes("ProjectHub.McpConfigBackup.v1"),DataProtectionScope.CurrentUser):before);JournalCreate(journal,recordId,"prepared.json",Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(record)));
        try{chain.Verify();journal.Verify();Check(file,targetPath,false,chain.Root);WriteExisting(file,after);chain.Verify();Check(file,targetPath,false,chain.Root);Dictionary<string,object> receipt=new Dictionary<string,object>{{"recordId",recordId},{"state","complete"},{"sha256",afterHash}};JournalCreate(journal,recordId,"complete.json",Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(receipt)));return new Dictionary<string,object>{{"bytes",after.Length},{"sha256",afterHash},{"beforeHash",beforeHash},{"fileFingerprint",fileId},{"recordId",recordId},{"overwritten",true}};}
        catch{throw new Rejected("RECOVERY_REQUIRED_"+recordId,409);}
      }finally{CloseHandle(file);}
    }
  }
  static Dictionary<string,object> Handle(Dictionary<string,object> request) {
    Supported();Require(request!=null,"INVALID_REQUEST",400);
    string mode=request.ContainsKey("mode")?request["mode"]as string:null;
    if(mode=="private-credential-create"){
      Exact(request,new string[]{"mode","root","rootFingerprint","path","dataBase64"});string[] credentialParts=Parts(request["path"]as string,false);Guid credentialId;string name=credentialParts.Length==3?credentialParts[2]:"";Require(credentialParts.Length==3&&credentialParts[0]=="_hub"&&credentialParts[1]=="MCP"&&name.Length==40&&name.EndsWith(".bin",StringComparison.Ordinal)&&Guid.TryParseExact(name.Substring(0,36),"D",out credentialId)&&name.Substring(0,36)==credentialId.ToString("D")&&name[14]=='4'&&"89ab".IndexOf(name[19])>=0,"INVALID_CREDENTIAL_PATH",400);string encoded=request["dataBase64"]as string;Require(encoded!=null&&encoded.Length<=87384,"CONTENT_REJECTED",415);byte[] cipher;try{cipher=Convert.FromBase64String(encoded);}catch{throw new Rejected("CONTENT_REJECTED",415);}Require(cipher.Length>0&&cipher.Length<=65536&&Convert.ToBase64String(cipher)==encoded,"CONTENT_REJECTED",415);using(Chain holder=new Chain(request["root"]as string,false)){Require(holder.Fingerprint()==request["rootFingerprint"]as string,"ROOT_CHANGED",403);return CreateBytes(holder,credentialParts,cipher,".key");}
    }
    if(mode=="private-config-write"&&request.ContainsKey("expectedHash")&&request["expectedHash"]as string=="missing"){
      Exact(request,new string[]{"mode","root","rootFingerprint","path","text","expectedHash","expectedFingerprint","journalRoot","journalRootFingerprint"});string[] configParts=Parts(request["path"]as string,false);Require(configParts.Length>0&&configParts[configParts.Length-1]=="config.toml"&&request["expectedFingerprint"]as string=="missing","INVALID_CONFIG_BINDING",400);
      using(Chain config=new Chain(request["root"]as string,false))using(Chain journal=new Chain(request["journalRoot"]as string,false,true)){Require(config.Fingerprint()==request["rootFingerprint"]as string&&journal.Fingerprint()==request["journalRootFingerprint"]as string,"ROOT_CHANGED",403);return Create(config,configParts,request["text"]as string,"missing");}
    }
    if(mode=="private-config-write"||mode=="private-config-recover")return Overwrite(request,mode=="private-config-recover",true);
    if(mode=="private-copy"||mode=="private-inspect"||mode=="private-remove"||mode=="private-artifact-copy"||mode=="private-artifact-inspect"||mode=="private-artifact-remove"||mode=="private-binary-copy"||mode=="private-binary-inspect")return Private(request,mode);
    if(mode=="overwrite"||mode=="recover")return Overwrite(request,mode=="recover");
    foreach(string key in request.Keys)Require(key=="mode"||key=="root"||key=="path"||key=="text"||key=="expectedHash"||key=="rootFingerprint","INVALID_REQUEST",400);
    if(mode=="probe"){Require(request.Count==1,"INVALID_REQUEST",400);return new Dictionary<string,object>{{"supported",true},{"build",26200},{"architecture","native-amd64"},{"overwrite",true}};}
    string root=request.ContainsKey("root")?request["root"]as string:null,relative=request.ContainsKey("path")?request["path"]as string:null;
    if(mode=="identity"){Require(request.Count==2,"INVALID_REQUEST",400);using(Chain chain=new Chain(root,false))return new Dictionary<string,object>{{"rootFingerprint",chain.Fingerprint()},{"filesystem","NTFS"}};}
    string[] parts=Parts(relative,mode=="read");using(Chain chain=new Chain(root,mode=="read"&&parts.Length==0)){
      Require(request.ContainsKey("rootFingerprint")&&request["rootFingerprint"]as string==chain.Fingerprint(),"ROOT_CHANGED",403);
      if(mode=="read"){Require(request.Count==4,"INVALID_REQUEST",400);return Read(chain,parts);}
      if(mode=="create"){Require(request.Count==6,"INVALID_REQUEST",400);return Create(chain,parts,request["text"]as string,request["expectedHash"]as string);}
      throw new Rejected("INVALID_MODE",400);
    }
  }
  static int Main() {
    JavaScriptSerializer json=new JavaScriptSerializer();json.MaxJsonLength=2*1024*1024;Console.InputEncoding=new UTF8Encoding(false,true);Console.OutputEncoding=new UTF8Encoding(false,true);
    try{string input=Console.In.ReadToEnd();Require(input.Length<=2*1024*1024,"REQUEST_TOO_LARGE",400);Dictionary<string,object> result=Handle(json.DeserializeObject(input)as Dictionary<string,object>);result["ok"]=true;Console.WriteLine(json.Serialize(result));return 0;}
    catch(Rejected error){Console.WriteLine(json.Serialize(new Dictionary<string,object>{{"ok",false},{"code",error.Code},{"status",error.Status}}));return 0;}
    catch{Console.WriteLine("{\"ok\":false,\"code\":\"BROKER_FAILURE\",\"status\":409}");return 0;}
  }
}
