// Internal web handoff controller only. Public scoped-file limits stay unchanged.
// Windows 26200 native AMD64 / NTFS: retain relative-open directory handles,
// deny directory delete sharing and file write/delete sharing, and compare
// file identity and full-byte hashes. Directory child creation remains possible.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Globalization;
using System.Web.Script.Serialization;

class WebHandoffWriter {
  const uint READ_DATA=1, WRITE_DATA=2, READ_ATTR=0x80, DELETE=0x10000, SYNC=0x100000;
  const uint DIRECTORY=1, NON_DIRECTORY=0x40, SYNCHRONOUS=0x20, OPEN_REPARSE=0x200000, COMPLETE_OPLOCK=0x100;
  const uint SHARE_READ=1, SHARE_WRITE=2, CREATE=2, OPEN=1, REPARSE=0x400, DIR_ATTR=0x10, NORMAL=0x80;
  const int METADATA=1024*1024, ROW=2*1024*1024, TASK=4*1024*1024, LOG=64*1024*1024, WIRE=400*1024*1024;
  [StructLayout(LayoutKind.Sequential)] struct UNICODE_STRING { public ushort Length,MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct OBJECT_ATTRIBUTES { public uint Length; public IntPtr RootDirectory,ObjectName; public uint Attributes; public IntPtr SecurityDescriptor,SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK { public IntPtr Status; public UIntPtr Information; }
  [StructLayout(LayoutKind.Sequential)] struct ATTRIBUTE_TAG { public uint Attributes,Tag; }
  [StructLayout(LayoutKind.Sequential)] struct FILE_TIME { public uint Low,High; }
  [StructLayout(LayoutKind.Sequential)] struct FILE_INFO { public uint Attributes; public FILE_TIME Creation,Access,Write; public uint VolumeSerial,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct VERSION_INFO { public uint Size,Major,Minor,Build,Platform; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string ServicePack; }
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr file,uint access,ref OBJECT_ATTRIBUTES attributes,out IO_STATUS_BLOCK io,IntPtr allocation,uint fileAttributes,uint sharing,uint disposition,uint options,IntPtr ea,uint eaLength);
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(IntPtr file,out IO_STATUS_BLOCK io,IntPtr information,uint length,int kind);
  [DllImport("ntdll.dll",CharSet=CharSet.Unicode)] static extern int RtlGetVersion(ref VERSION_INFO version);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsWow64Process2(IntPtr process,out ushort processMachine,out ushort nativeMachine);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint sharing,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr file,StringBuilder name,uint length,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformationByHandleW(IntPtr file,StringBuilder volume,uint volumeLength,out uint serial,out uint component,out uint flags,StringBuilder filesystem,uint filesystemLength);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetDiskFreeSpaceExW(string directory,out ulong available,out ulong total,out ulong free);
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
  class Rejected : Exception {
    public string Code,RecordId; public int Status; public bool Partial;
    public Rejected(string code,int status=409,string recordId=null,bool partial=false) { Code=code;Status=status;RecordId=recordId;Partial=partial; }
  }
  static void Require(bool ok,string code,int status=409) { if(!ok)throw new Rejected(code,status); }
  static void Supported() {
    VERSION_INFO v=new VERSION_INFO();v.Size=(uint)Marshal.SizeOf(typeof(VERSION_INFO));ushort processMachine,nativeMachine;
    Require(IntPtr.Size==8&&RtlGetVersion(ref v)==0&&v.Major==10&&v.Minor==0&&v.Build==26200&&IsWow64Process2(GetCurrentProcess(),out processMachine,out nativeMachine)&&processMachine==0&&nativeMachine==0x8664,"UNSUPPORTED_PLATFORM");
    Require(Marshal.SizeOf(typeof(UNICODE_STRING))==16&&Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES))==48&&Marshal.SizeOf(typeof(IO_STATUS_BLOCK))==16,"UNSUPPORTED_ABI");
  }
  static bool ValidComponent(string name) {
    if(String.IsNullOrEmpty(name)||name.Length>255||name=="."||name==".."||name.EndsWith(".")||name.EndsWith(" "))return false;
    foreach(char c in name)if(c<32||c==127||"\\/:*?\"<>|".IndexOf(c)>=0)return false;
    string stem=name.Split('.')[0].ToUpperInvariant();
    if(stem=="CON"||stem=="PRN"||stem=="AUX"||stem=="NUL"||stem=="CONIN$"||stem=="CONOUT$")return false;
    if(stem.Length==4&&(stem.StartsWith("COM")||stem.StartsWith("LPT"))&&("123456789\u00b9\u00b2\u00b3".IndexOf(stem[3])>=0))return false;
    return true;
  }
  static string[] Parts(string relative,bool empty) {
    Require(relative!=null&&relative.Length<=32768,"INVALID_PATH",403);
    if(relative==""&&empty)return new string[0];
    string[] parts=relative.Replace('/','\\').Split('\\');Require(parts.Length<=128,"PATH_DEPTH_LIMIT",403);
    foreach(string part in parts)Require(ValidComponent(part),"INVALID_PATH",403);return parts;
  }
  static string NormalRoot(string root) {
    Require(root!=null&&root.Length>=3&&root.Length<=32768&&Char.IsLetter(root[0])&&root[1]==':'&&(root[2]=='\\'||root[2]=='/'),"INVALID_ROOT",403);
    string normal=root.Replace('/','\\').TrimEnd('\\');Require(normal.Length>3,"ROOT_REQUIRED",403);Parts(normal.Substring(3),false);
    Require(GetDriveTypeW(normal.Substring(0,3))==3,"NONLOCAL_DRIVE",403);return normal;
  }
  static string FinalName(IntPtr file) {
    StringBuilder b=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(file,b,(uint)b.Capacity,0);
    Require(n>0&&n<b.Capacity,"FINAL_PATH_UNAVAILABLE");string result=b.ToString();
    Require(result.StartsWith("\\\\?\\")&&!result.StartsWith("\\\\?\\UNC\\",StringComparison.OrdinalIgnoreCase),"NONLOCAL_PATH",403);
    result=result.Substring(4);if(result.Length>3)result=result.TrimEnd('\\');return result;
  }
  static void Check(IntPtr file,string expected,bool directory,string root) {
    ATTRIBUTE_TAG tag=new ATTRIBUTE_TAG();Require(GetFileType(file)==1&&GetFileInformationByHandleEx(file,9,out tag,8),"INVALID_FILE_TYPE",415);
    Require((tag.Attributes&REPARSE)==0,"REPARSE_REJECTED",403);Require(((tag.Attributes&DIR_ATTR)!=0)==directory,"INVALID_FILE_TYPE",415);
    string actual=FinalName(file);Require(String.Equals(actual,expected,StringComparison.OrdinalIgnoreCase),"PATH_CHANGED",403);
    if(root!=null)Require(String.Equals(actual,root,StringComparison.OrdinalIgnoreCase)||actual.StartsWith(root.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase),"OUTSIDE_ROOT",403);
    if(!directory){FILE_INFO info;Require(GetFileInformationByHandle(file,out info)&&info.Links==1,"MULTIPLE_LINKS_REJECTED",403);}
  }
  static IntPtr OpenRelative(IntPtr parent,string name,uint access,uint disposition,uint options,out int status) {
    IntPtr text=Marshal.StringToHGlobalUni(name),unicode=IntPtr.Zero,file=IntPtr.Zero;
    try {
      UNICODE_STRING u=new UNICODE_STRING();u.Buffer=text;u.Length=(ushort)(name.Length*2);u.MaximumLength=(ushort)(u.Length+2);
      unicode=Marshal.AllocHGlobal(16);Marshal.StructureToPtr(u,unicode,false);
      OBJECT_ATTRIBUTES a=new OBJECT_ATTRIBUTES();a.Length=48;a.RootDirectory=parent;a.ObjectName=unicode;a.Attributes=0x40|0x1000;
      IO_STATUS_BLOCK io;status=NtCreateFile(out file,access|READ_ATTR|SYNC,ref a,out io,IntPtr.Zero,NORMAL,SHARE_READ|((options&DIRECTORY)!=0?SHARE_WRITE:0),disposition,options|SYNCHRONOUS|OPEN_REPARSE|COMPLETE_OPLOCK,IntPtr.Zero,0);
      if(status!=0){if(file!=IntPtr.Zero&&file!=new IntPtr(-1))CloseHandle(file);return IntPtr.Zero;}return file;
    } finally {if(unicode!=IntPtr.Zero)Marshal.FreeHGlobal(unicode);Marshal.FreeHGlobal(text);}
  }
  static bool Missing(int status) {uint s=unchecked((uint)status);return s==0xC0000034||s==0xC000003A;}
  static void Status(int status) {
    if(status==0)return;uint s=unchecked((uint)status);
    if(Missing(status))throw new Rejected("NOT_FOUND",404);
    if(s==0xC0000035)throw new Rejected("DESTINATION_EXISTS");
    if(s==0xC000050B||s==0xC0000275||s==0xC0000280)throw new Rejected("REPARSE_REJECTED",403);
    if(s==0xC0000022)throw new Rejected("ACCESS_DENIED",403);
    if(s==0xC000007F||s==0xC0000044)throw new Rejected("DISK_FULL",507);
    throw new Rejected("NT_OPERATION_REJECTED_"+s.ToString("X8"));
  }
  class Chain : IDisposable {
    public List<IntPtr> Handles=new List<IntPtr>();public string Root,Current;public bool Created;
    public IntPtr Last {get{return Handles[Handles.Count-1];}}
    public Chain(string root,bool create=false) {
      Root=NormalRoot(root);Current=Root.Substring(0,3);
      IntPtr drive=CreateFileW(Current,READ_ATTR|SYNC|0x20,SHARE_READ|SHARE_WRITE,IntPtr.Zero,3,0x02000000|0x00200000,IntPtr.Zero);
      Require(drive!=IntPtr.Zero&&drive!=new IntPtr(-1),"ROOT_OPEN_FAILED");Handles.Add(drive);
      try {
        Check(drive,Current,true,null);StringBuilder volume=new StringBuilder(260),filesystem=new StringBuilder(32);uint serial,component,flags;
        Require(GetVolumeInformationByHandleW(drive,volume,260,out serial,out component,out flags,filesystem,32)&&filesystem.ToString()=="NTFS","UNSUPPORTED_FILESYSTEM");
        foreach(string part in Parts(Root.Substring(3),false))Next(part,create);Verify();
      }catch{Dispose();throw;}
    }
    public void Next(string part,bool create) {
      Require(ValidComponent(part),"INVALID_PATH",403);int status;IntPtr file=OpenRelative(Last,part,0x20,OPEN,DIRECTORY,out status);
      if(create&&unchecked((uint)status)==0xC0000034){file=OpenRelative(Last,part,0x20,CREATE,DIRECTORY,out status);if(status==0)Created=true;}
      Status(status);Handles.Add(file);Current=Current.TrimEnd('\\')+"\\"+part;Check(file,Current,true,null);
    }
    public void Verify(){Check(Last,Current,true,Root);}
    public string Fingerprint(){return FileFingerprint(Last,Root);}
    public void Dispose(){for(int i=Handles.Count-1;i>=0;i--)CloseHandle(Handles[i]);Handles.Clear();}
  }
  static string Hash(byte[] bytes){using(SHA256 sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
  static FILE_INFO FileIdentity(IntPtr file){FILE_INFO info;Require(GetFileInformationByHandle(file,out info),"FILE_ID_UNAVAILABLE");return info;}
  static bool SameIdentity(FILE_INFO first,FILE_INFO second){return first.VolumeSerial==second.VolumeSerial&&first.IndexHigh==second.IndexHigh&&first.IndexLow==second.IndexLow;}
  static string FileFingerprint(IntPtr file,string name){FILE_INFO info;Require(GetFileInformationByHandle(file,out info),"FILE_ID_UNAVAILABLE");ulong index=((ulong)info.IndexHigh<<32)|info.IndexLow;return Hash(Encoding.UTF8.GetBytes(name+"\n"+info.VolumeSerial.ToString(CultureInfo.InvariantCulture)+"\n"+index.ToString(CultureInfo.InvariantCulture)));}
  static bool PendingTempName(string name){if(name==null||name.Length!=45||!name.StartsWith(".hub-web-",StringComparison.OrdinalIgnoreCase)||!name.EndsWith(".tmp",StringComparison.OrdinalIgnoreCase))return false;for(int i=9;i<41;i++)if("0123456789abcdef".IndexOf(Char.ToLowerInvariant(name[i]))<0)return false;return true;}
  static bool Digest(string value){if(value==null||value.Length!=64)return false;foreach(char c in value)if("0123456789abcdef".IndexOf(c)<0)return false;return true;}
  static IntPtr OpenFile(Chain chain,string[] parts,uint access) {
    Require(parts.Length>0,"FILE_REQUIRED",400);for(int i=0;i<parts.Length-1;i++)chain.Next(parts[i],false);chain.Verify();
    int status;IntPtr file=OpenRelative(chain.Last,parts[parts.Length-1],access,OPEN,NON_DIRECTORY,out status);Status(status);
    try{Check(file,chain.Current+"\\"+parts[parts.Length-1],false,chain.Root);return file;}catch{CloseHandle(file);throw;}
  }
  static byte[] Bytes(IntPtr file,int max) {
    long size;Require(GetFileSizeEx(file,out size)&&size>=0&&size<=max,"FILE_SIZE_REJECTED",413);
    long position;Require(SetFilePointerEx(file,0,out position,0)&&position==0,"READ_SEEK_FAILED");byte[] bytes=new byte[(int)size];uint read;
    Require(ReadFile(file,bytes,(uint)bytes.Length,out read,IntPtr.Zero)&&read==bytes.Length,"READ_INCOMPLETE");return bytes;
  }
  static string Decode(byte[] bytes){Require(Array.IndexOf(bytes,(byte)0)<0,"BINARY_REJECTED",415);try{return new UTF8Encoding(false,true).GetString(bytes);}catch(DecoderFallbackException){throw new Rejected("ENCODING_REJECTED",415);}}
  static byte[] TextBytes(string text,int max){Require(text!=null,"INVALID_CONTENT",400);byte[] bytes;try{bytes=new UTF8Encoding(false,true).GetBytes(text);}catch(EncoderFallbackException){throw new Rejected("ENCODING_REJECTED",415);}Require(bytes.Length<=max,"CONTENT_TOO_LARGE",413);Require(Array.IndexOf(bytes,(byte)0)<0,"INVALID_CONTENT",400);return bytes;}
  static void DeleteTemp(IntPtr file){IntPtr buffer=Marshal.AllocHGlobal(1);try{Marshal.WriteByte(buffer,1);IO_STATUS_BLOCK io;Status(NtSetInformationFile(file,out io,buffer,1,13));}finally{Marshal.FreeHGlobal(buffer);}}
  static void Rename(IntPtr temp,IntPtr parent,string name){byte[] bytes=Encoding.Unicode.GetBytes(name);int size=Math.Max(24,20+bytes.Length);IntPtr buffer=Marshal.AllocHGlobal(size);try{for(int i=0;i<size;i++)Marshal.WriteByte(buffer,i,0);Marshal.WriteIntPtr(buffer,8,parent);Marshal.WriteInt32(buffer,16,bytes.Length);Marshal.Copy(bytes,0,IntPtr.Add(buffer,20),bytes.Length);IO_STATUS_BLOCK io;Status(NtSetInformationFile(temp,out io,buffer,(uint)size,10));}finally{Marshal.FreeHGlobal(buffer);}}
  static void Write(IntPtr file,byte[] bytes){long position;Require(SetFilePointerEx(file,0,out position,0)&&position==0,"WRITE_SEEK_FAILED");uint written;Require(WriteFile(file,bytes,(uint)bytes.Length,out written,IntPtr.Zero)&&written==bytes.Length&&SetEndOfFile(file)&&FlushFileBuffers(file),"WRITE_INCOMPLETE");Require(Hash(Bytes(file,bytes.Length))==Hash(bytes),"WRITE_VERIFY_FAILED");}
  static Dictionary<string,object> CreateBytes(Chain chain,string[] parts,byte[] bytes){
    Require(parts.Length>0,"FILE_REQUIRED",400);Require(!PendingTempName(parts[parts.Length-1]),"RESERVED_TEMP_NAME",403);for(int i=0;i<parts.Length-1;i++)chain.Next(parts[i],true);chain.Verify();int status;
    IntPtr existing=OpenRelative(chain.Last,parts[parts.Length-1],0,OPEN,0,out status);
    if(status==0){try{ATTRIBUTE_TAG tag;Require(GetFileInformationByHandleEx(existing,9,out tag,8),"FILE_TYPE_UNAVAILABLE");Require((tag.Attributes&REPARSE)==0,"REPARSE_REJECTED",403);}finally{CloseHandle(existing);}throw new Rejected("DESTINATION_EXISTS");}
    if(unchecked((uint)status)!=0xC0000034)Status(status);
    string tempName=".hub-web-"+Guid.NewGuid().ToString("N")+".tmp",full=chain.Current+"\\"+parts[parts.Length-1];
    IntPtr temp=OpenRelative(chain.Last,tempName,READ_DATA|WRITE_DATA|DELETE,CREATE,NON_DIRECTORY|2,out status);Status(status);bool moved=false;
    try{
      Check(temp,chain.Current+"\\"+tempName,false,chain.Root);FILE_INFO identity=FileIdentity(temp);string expectedHash=Hash(bytes);
      Write(temp,bytes);chain.Verify();Require(SameIdentity(identity,FileIdentity(temp)),"CREATE_FILE_CHANGED",403);
      Rename(temp,chain.Last,parts[parts.Length-1]);moved=true;
      Require(FlushFileBuffers(temp),"CREATE_FLUSH_INCOMPLETE");Check(temp,full,false,chain.Root);chain.Verify();
      Require(SameIdentity(identity,FileIdentity(temp)),"CREATE_FILE_CHANGED",403);Require(Hash(Bytes(temp,bytes.Length))==expectedHash,"CREATE_VERIFY_FAILED");
      return new Dictionary<string,object>{{"missing",false},{"created",true},{"flushed",true},{"sha256",expectedHash},{"bytes",bytes.Length},{"fileFingerprint",FileFingerprint(temp,full)}};
    }
    catch(Rejected error){if(moved)throw new Rejected(error.Code,error.Status,null,true);throw;}
    catch{if(moved)throw new Rejected("CREATE_RECOVERY_REQUIRED",409,null,true);throw;}
    finally{try{if(!moved)DeleteTemp(temp);}finally{CloseHandle(temp);}}
  }
  static int Limit(string kind){switch(kind){case "raw-result":return 256*1024;case "row":return ROW;case "task":return TASK;case "metadata":return METADATA;case "log":return LOG;default:throw new Rejected("INVALID_KIND",400);}}
  static void Exact(Dictionary<string,object> request,string[] keys){Require(request.Count==keys.Length,"INVALID_REQUEST",400);foreach(string key in keys)Require(request.ContainsKey(key),"INVALID_REQUEST",400);}
  static void Pin(Chain chain,string fingerprint,string code){Require(Digest(fingerprint)&&fingerprint==chain.Fingerprint(),code,403);}
  static byte[] Serialize(object value){return Encoding.UTF8.GetBytes(Serializer().Serialize(value));}
  static JavaScriptSerializer Serializer(){JavaScriptSerializer s=new JavaScriptSerializer();s.MaxJsonLength=WIRE;s.RecursionLimit=32;return s;}
  static Dictionary<string,object> JournalCreate(Chain journal,string id,string name,byte[] bytes){if(name.EndsWith(".json",StringComparison.Ordinal))Require(bytes.Length<=METADATA,"METADATA_TOO_LARGE",413);using(Chain writer=new Chain(journal.Root)){Pin(writer,journal.Fingerprint(),"JOURNAL_ROOT_CHANGED");return CreateBytes(writer,Parts(id+"/"+name,false),bytes);}}
  static byte[] JournalRead(Chain journal,string id,string name,int max,out bool missing){return JournalRead(journal,id,name,max,out missing,null);}
  static byte[] JournalRead(Chain journal,string id,string name,int max,out bool missing,string expectedFingerprint){using(Chain reader=new Chain(journal.Root)){Pin(reader,journal.Fingerprint(),"JOURNAL_ROOT_CHANGED");IntPtr file=IntPtr.Zero;try{file=OpenFile(reader,Parts(id+"/"+name,false),READ_DATA);missing=false;if(expectedFingerprint!=null)Require(FileFingerprint(file,reader.Current+"\\"+name)==expectedFingerprint,"JOURNAL_FILE_CHANGED");return Bytes(file,max);}catch(Rejected error){if(error.Code!="NOT_FOUND")throw;missing=true;return null;}finally{if(file!=IntPtr.Zero)CloseHandle(file);}}}
  static Dictionary<string,object> MissingAppend(Dictionary<string,object> request){
    string id=request["recordId"]as string;Guid parsed;Require(id!=null&&Guid.TryParseExact(id,"N",out parsed)&&id==parsed.ToString("N"),"INVALID_RECORD",400);
    byte[] delta=TextBytes(request["text"]as string,ROW);string[] parts=Parts(request["path"]as string,false);
    using(Chain chain=new Chain(request["root"]as string))using(Chain journal=new Chain(request["journalRoot"]as string)){
      Pin(chain,request["rootFingerprint"]as string,"ROOT_CHANGED");Pin(journal,request["journalRootFingerprint"]as string,"JOURNAL_ROOT_CHANGED");
      Require(!String.Equals(chain.Root,journal.Root,StringComparison.OrdinalIgnoreCase)&&!journal.Root.StartsWith(chain.Root+"\\",StringComparison.OrdinalIgnoreCase)&&!chain.Root.StartsWith(journal.Root+"\\",StringComparison.OrdinalIgnoreCase),"JOURNAL_OVERLAP_REJECTED",403);
      string rootPin=chain.Fingerprint();bool missing,prepared=false;IntPtr file=IntPtr.Zero;
      try{
        byte[] intentBytes=JournalRead(journal,id,"intent.json",METADATA,out missing);string afterHash=Hash(delta);
        if(!missing){
          Dictionary<string,object> intent=Serializer().DeserializeObject(Decode(intentBytes))as Dictionary<string,object>;Require(intent!=null,"JOURNAL_INVALID");
          Exact(intent,new string[]{"version","recordId","mode","root","rootFingerprint","path","fileFingerprint","beforeHash","afterHash","deltaHash","beforeBytes","afterBytes","beforeBlobFingerprint","afterBlobFingerprint","state"});
          Require(intent["version"]is int&&(int)intent["version"]==1&&intent["recordId"]as string==id&&intent["mode"]as string=="append"&&intent["root"]as string==chain.Root&&intent["rootFingerprint"]as string==rootPin&&intent["path"]as string==request["path"]as string&&intent["fileFingerprint"]as string=="missing"&&intent["beforeHash"]as string=="missing"&&intent["afterHash"]as string==afterHash&&intent["deltaHash"]as string==afterHash&&intent["beforeBytes"]is int&&(int)intent["beforeBytes"]==0&&intent["afterBytes"]is int&&(int)intent["afterBytes"]==delta.Length&&intent["state"]as string=="prepared"&&Digest(intent["beforeBlobFingerprint"]as string)&&Digest(intent["afterBlobFingerprint"]as string),"RETRY_BINDING_CHANGED");
          byte[] backup=JournalRead(journal,id,"before.bin",0,out missing,intent["beforeBlobFingerprint"]as string);Require(!missing&&backup.Length==0,"BACKUP_CHANGED");
          byte[] after=JournalRead(journal,id,"after.bin",ROW,out missing,intent["afterBlobFingerprint"]as string);Require(!missing&&Hash(after)==afterHash,"AFTER_BLOB_CHANGED");prepared=true;
        }else{
          // Inspect before preparing anything; a competing file is never adopted.
          try{file=OpenFile(chain,parts,READ_DATA);throw new Rejected("DESTINATION_EXISTS");}catch(Rejected error){if(error.Code!="NOT_FOUND")throw;}finally{if(file!=IntPtr.Zero){CloseHandle(file);file=IntPtr.Zero;}}
          Dictionary<string,object> beforeBlob=JournalCreate(journal,id,"before.bin",new byte[0]),afterBlob=JournalCreate(journal,id,"after.bin",delta);
          JournalCreate(journal,id,"intent.json",Serialize(new Dictionary<string,object>{{"version",1},{"recordId",id},{"mode","append"},{"root",chain.Root},{"rootFingerprint",rootPin},{"path",request["path"]},{"fileFingerprint","missing"},{"beforeHash","missing"},{"afterHash",afterHash},{"deltaHash",afterHash},{"beforeBytes",0},{"afterBytes",delta.Length},{"beforeBlobFingerprint",beforeBlob["fileFingerprint"]},{"afterBlobFingerprint",afterBlob["fileFingerprint"]},{"state","prepared"}}));prepared=true;
          // OpenFile may have traversed existing parents. Reopen from the root.
        }
        byte[] createdBytes=JournalRead(journal,id,"created.json",METADATA,out missing);string fileId;
        using(Chain target=new Chain(chain.Root)){
          Pin(target,rootPin,"ROOT_CHANGED");
          if(missing){
            bool exists=false;try{file=OpenFile(target,parts,READ_DATA);exists=true;}catch(Rejected error){if(error.Code!="NOT_FOUND")throw;}finally{if(file!=IntPtr.Zero){CloseHandle(file);file=IntPtr.Zero;}}
            Require(!exists,"UNBOUND_CREATED_TARGET");
            using(Chain creator=new Chain(chain.Root)){
              Pin(creator,rootPin,"ROOT_CHANGED");Dictionary<string,object> created=CreateBytes(creator,parts,delta);fileId=created["fileFingerprint"]as string;
              JournalCreate(journal,id,"created.json",Serialize(new Dictionary<string,object>{{"recordId",id},{"sha256",afterHash},{"fileFingerprint",fileId},{"state","created"}}));
            }
          }else{
            Dictionary<string,object> created=Serializer().DeserializeObject(Decode(createdBytes))as Dictionary<string,object>;Require(created!=null,"JOURNAL_INVALID");Exact(created,new string[]{"recordId","sha256","fileFingerprint","state"});fileId=created["fileFingerprint"]as string;
            Require(created["recordId"]as string==id&&created["sha256"]as string==afterHash&&created["state"]as string=="created"&&Digest(fileId),"JOURNAL_INVALID");
          }
        }
        using(Chain check=new Chain(chain.Root)){
          Pin(check,rootPin,"ROOT_CHANGED");file=OpenFile(check,parts,READ_DATA);string full=check.Current+"\\"+parts[parts.Length-1];
          Require(FileFingerprint(file,full)==fileId&&Hash(Bytes(file,LOG))==afterHash,"CREATED_TARGET_CHANGED");check.Verify();Check(file,full,false,check.Root);
          byte[] complete=JournalRead(journal,id,"complete.json",METADATA,out missing);bool retried=!missing;
          if(retried){Dictionary<string,object> receipt=Serializer().DeserializeObject(Decode(complete))as Dictionary<string,object>;Require(receipt!=null,"JOURNAL_INVALID");Exact(receipt,new string[]{"recordId","state","sha256","fileFingerprint"});Require(receipt["recordId"]as string==id&&receipt["state"]as string=="complete"&&receipt["sha256"]as string==afterHash&&receipt["fileFingerprint"]as string==fileId,"JOURNAL_INVALID");}
          else JournalCreate(journal,id,"complete.json",Serialize(new Dictionary<string,object>{{"recordId",id},{"state","complete"},{"sha256",afterHash},{"fileFingerprint",fileId}}));
          Dictionary<string,object> result=MutationResult("append",id,"missing",afterHash,fileId,delta.Length,retried);result["created"]=true;return result;
        }
      }catch(Rejected error){if(prepared&&!error.Partial)throw new Rejected(error.Code,error.Status,id,true);throw;}
      catch{if(prepared)throw new Rejected("RECOVERY_REQUIRED",409,id,true);throw;}
      finally{if(file!=IntPtr.Zero)CloseHandle(file);}
    }
  }
  static Dictionary<string,object> Mutation(Dictionary<string,object> request,string mode){
    Exact(request,new string[]{"mode","root","path","text","expectedHash","expectedFingerprint","rootFingerprint","journalRoot","journalRootFingerprint","recordId"});
    if(mode=="append"&&request["expectedHash"]as string=="missing"&&request["expectedFingerprint"]as string=="missing")return MissingAppend(request);
    string id=request["recordId"]as string;Guid parsed;Require(id!=null&&Guid.TryParseExact(id,"N",out parsed)&&id==parsed.ToString("N"),"INVALID_RECORD",400);
    Require(Digest(request["expectedHash"]as string)&&Digest(request["expectedFingerprint"]as string),"INVALID_BEFORE_IDENTITY",400);
    byte[] delta=TextBytes(request["text"]as string,mode=="append"?ROW:TASK);string[] parts=Parts(request["path"]as string,false);
    using(Chain chain=new Chain(request["root"]as string))using(Chain journal=new Chain(request["journalRoot"]as string)){
      Pin(chain,request["rootFingerprint"]as string,"ROOT_CHANGED");Pin(journal,request["journalRootFingerprint"]as string,"JOURNAL_ROOT_CHANGED");
      Require(!String.Equals(chain.Root,journal.Root,StringComparison.OrdinalIgnoreCase)&&!journal.Root.StartsWith(chain.Root+"\\",StringComparison.OrdinalIgnoreCase)&&!chain.Root.StartsWith(journal.Root+"\\",StringComparison.OrdinalIgnoreCase),"JOURNAL_OVERLAP_REJECTED",403);
      IntPtr file=OpenFile(chain,parts,READ_DATA|WRITE_DATA);bool prepared=false;
      try {
        string full=chain.Current+"\\"+parts[parts.Length-1],fileId=FileFingerprint(file,full),expected=request["expectedHash"]as string;
        Require(fileId==request["expectedFingerprint"]as string,"FILE_CHANGED");
        byte[] current=Bytes(file,mode=="append"?LOG:TASK);Decode(current);string currentHash=Hash(current);bool missing;
        byte[] intentBytes=JournalRead(journal,id,"intent.json",METADATA,out missing);byte[] after;string afterHash;
        if(!missing){
          Dictionary<string,object> intent=Serializer().DeserializeObject(Decode(intentBytes))as Dictionary<string,object>;Require(intent!=null,"JOURNAL_INVALID");
          Exact(intent,new string[]{"version","recordId","mode","root","rootFingerprint","path","fileFingerprint","beforeHash","afterHash","deltaHash","beforeBytes","afterBytes","beforeBlobFingerprint","afterBlobFingerprint","state"});
          Require(intent["version"]is int&&(int)intent["version"]==1&&intent["recordId"]as string==id&&intent["mode"]as string==mode&&intent["root"]as string==chain.Root&&intent["rootFingerprint"]as string==request["rootFingerprint"]as string&&intent["path"]as string==request["path"]as string&&intent["fileFingerprint"]as string==fileId&&intent["beforeHash"]as string==expected&&intent["deltaHash"]as string==Hash(delta)&&intent["state"]as string=="prepared"&&Digest(intent["afterHash"]as string),"RETRY_BINDING_CHANGED");
          Require(Digest(intent["beforeBlobFingerprint"]as string)&&Digest(intent["afterBlobFingerprint"]as string),"JOURNAL_INVALID");
          Require(intent["beforeBytes"]is int&&intent["afterBytes"]is int&&(int)intent["beforeBytes"]>=0&&(int)intent["beforeBytes"]<=(mode=="append"?LOG:TASK)&&(int)intent["afterBytes"]>=0&&(int)intent["afterBytes"]<=(mode=="append"?LOG:TASK),"JOURNAL_INVALID");
          byte[] backup=JournalRead(journal,id,"before.bin",mode=="append"?LOG:TASK,out missing,intent["beforeBlobFingerprint"]as string);Require(!missing&&Hash(backup)==expected&&backup.Length==Convert.ToInt32(intent["beforeBytes"],CultureInfo.InvariantCulture),"BACKUP_CHANGED");Decode(backup);
          after=JournalRead(journal,id,"after.bin",mode=="append"?LOG:TASK,out missing,intent["afterBlobFingerprint"]as string);afterHash=intent["afterHash"]as string;Require(!missing&&Hash(after)==afterHash&&after.Length==Convert.ToInt32(intent["afterBytes"],CultureInfo.InvariantCulture),"AFTER_BLOB_CHANGED");Decode(after);
          byte[] calculated=mode=="append"?Join(backup,delta):delta;Require(Hash(calculated)==afterHash,"RETRY_BINDING_CHANGED");
          byte[] complete=JournalRead(journal,id,"complete.json",METADATA,out missing);
          if(!missing){Dictionary<string,object> receipt=Serializer().DeserializeObject(Decode(complete))as Dictionary<string,object>;Require(receipt!=null,"JOURNAL_INVALID");Exact(receipt,new string[]{"recordId","state","sha256","fileFingerprint"});Require(receipt["recordId"]as string==id&&receipt["state"]as string=="complete"&&receipt["sha256"]as string==afterHash&&receipt["fileFingerprint"]as string==fileId,"JOURNAL_INVALID");Require(currentHash==afterHash,"COMPLETED_TARGET_CHANGED");Check(file,full,false,chain.Root);chain.Verify();return MutationResult(mode,id,expected,afterHash,fileId,current.Length,true);}
          prepared=true;Require(currentHash==expected||currentHash==afterHash,"RECOVERY_REQUIRED");
        }else{
          Require(currentHash==expected,"HASH_CHANGED");after=mode=="append"?Join(current,delta):delta;afterHash=Hash(after);
          Dictionary<string,object> intent=new Dictionary<string,object>{{"version",1},{"recordId",id},{"mode",mode},{"root",chain.Root},{"rootFingerprint",request["rootFingerprint"]},{"path",request["path"]},{"fileFingerprint",fileId},{"beforeHash",expected},{"afterHash",afterHash},{"deltaHash",Hash(delta)},{"beforeBytes",current.Length},{"afterBytes",after.Length},{"state","prepared"}};
          // Full byte blobs are separate from bounded metadata. They are never overwritten.
          Dictionary<string,object> beforeBlob=JournalCreate(journal,id,"before.bin",current),afterBlob=JournalCreate(journal,id,"after.bin",after);
          intent["beforeBlobFingerprint"]=beforeBlob["fileFingerprint"];intent["afterBlobFingerprint"]=afterBlob["fileFingerprint"];
          JournalCreate(journal,id,"intent.json",Serialize(intent));prepared=true;
        }
        try {
          chain.Verify();journal.Verify();Check(file,full,false,chain.Root);
          Require(FileFingerprint(file,full)==fileId,"FILE_CHANGED");
          if(currentHash!=afterHash){Require(Hash(Bytes(file,mode=="append"?LOG:TASK))==expected,"HASH_CHANGED");Write(file,after);}
          // An interrupted attempt may have reached the expected bytes without
          // completing its flush. Reflush before creating a completion receipt.
          Require(FlushFileBuffers(file),"WRITE_FLUSH_INCOMPLETE");
          Require(Hash(Bytes(file,mode=="append"?LOG:TASK))==afterHash,"WRITE_VERIFY_FAILED");Check(file,full,false,chain.Root);chain.Verify();Require(FileFingerprint(file,full)==fileId,"FILE_CHANGED");
          JournalCreate(journal,id,"complete.json",Serialize(new Dictionary<string,object>{{"recordId",id},{"state","complete"},{"sha256",afterHash},{"fileFingerprint",fileId}}));
          return MutationResult(mode,id,expected,afterHash,fileId,after.Length,false);
        }catch{throw new Rejected("RECOVERY_REQUIRED",409,id,true);}
      }catch(Rejected error){if(prepared&&!error.Partial)throw new Rejected(error.Code,error.Status,id,true);throw;}
      finally{CloseHandle(file);}
    }
  }
  static byte[] Join(byte[] before,byte[] delta){Require((long)before.Length+delta.Length<=LOG,"FILE_SIZE_REJECTED",413);byte[] result=new byte[before.Length+delta.Length];Buffer.BlockCopy(before,0,result,0,before.Length);Buffer.BlockCopy(delta,0,result,before.Length,delta.Length);return result;}
  static Dictionary<string,object> Recover(Dictionary<string,object> request){
    Exact(request,new string[]{"mode","root","path","expectedHash","expectedFingerprint","rootFingerprint","journalRoot","journalRootFingerprint","recordId"});
    string id=request["recordId"]as string;Guid parsed;Require(id!=null&&Guid.TryParseExact(id,"N",out parsed)&&id==parsed.ToString("N")&&Digest(request["expectedHash"]as string)&&Digest(request["expectedFingerprint"]as string),"INVALID_RECOVERY",400);
    using(Chain chain=new Chain(request["root"]as string))using(Chain journal=new Chain(request["journalRoot"]as string)){
      Pin(chain,request["rootFingerprint"]as string,"ROOT_CHANGED");Pin(journal,request["journalRootFingerprint"]as string,"JOURNAL_ROOT_CHANGED");
      Require(!String.Equals(chain.Root,journal.Root,StringComparison.OrdinalIgnoreCase)&&!journal.Root.StartsWith(chain.Root+"\\",StringComparison.OrdinalIgnoreCase)&&!chain.Root.StartsWith(journal.Root+"\\",StringComparison.OrdinalIgnoreCase),"JOURNAL_OVERLAP_REJECTED",403);
      bool missing;byte[] complete=JournalRead(journal,id,"complete.json",METADATA,out missing);Require(missing,"RECORD_COMPLETE");
      byte[] intentBytes=JournalRead(journal,id,"intent.json",METADATA,out missing);Require(!missing,"JOURNAL_MISSING");Dictionary<string,object> intent=Serializer().DeserializeObject(Decode(intentBytes))as Dictionary<string,object>;Require(intent!=null,"JOURNAL_INVALID");
      Exact(intent,new string[]{"version","recordId","mode","root","rootFingerprint","path","fileFingerprint","beforeHash","afterHash","deltaHash","beforeBytes","afterBytes","beforeBlobFingerprint","afterBlobFingerprint","state"});
      string mode=intent["mode"]as string,fileId=intent["fileFingerprint"]as string;int max=mode=="append"?LOG:TASK;
      Require(intent["version"]is int&&(int)intent["version"]==1&&intent["recordId"]as string==id&&(mode=="append"||mode=="overwrite")&&intent["root"]as string==chain.Root&&intent["rootFingerprint"]as string==request["rootFingerprint"]as string&&intent["path"]as string==request["path"]as string&&fileId==request["expectedFingerprint"]as string&&intent["state"]as string=="prepared"&&Digest(intent["beforeHash"]as string)&&Digest(intent["afterHash"]as string)&&Digest(intent["beforeBlobFingerprint"]as string)&&Digest(intent["afterBlobFingerprint"]as string),"RECOVERY_BINDING_CHANGED");
      Require(intent["beforeBytes"]is int&&intent["afterBytes"]is int&&(int)intent["beforeBytes"]>=0&&(int)intent["beforeBytes"]<=max&&(int)intent["afterBytes"]>=0&&(int)intent["afterBytes"]<=max&&Digest(intent["deltaHash"]as string),"JOURNAL_INVALID");
      byte[] backup=JournalRead(journal,id,"before.bin",max,out missing,intent["beforeBlobFingerprint"]as string);Require(!missing&&Hash(backup)==intent["beforeHash"]as string&&backup.Length==Convert.ToInt32(intent["beforeBytes"],CultureInfo.InvariantCulture),"BACKUP_CHANGED");Decode(backup);
      byte[] after=JournalRead(journal,id,"after.bin",max,out missing,intent["afterBlobFingerprint"]as string);Require(!missing&&Hash(after)==intent["afterHash"]as string&&after.Length==Convert.ToInt32(intent["afterBytes"],CultureInfo.InvariantCulture),"AFTER_BLOB_CHANGED");Decode(after);
      if(mode=="overwrite")Require(Hash(after)==intent["deltaHash"]as string,"RECOVERY_BINDING_CHANGED");
      else{
        Require(after.Length>=backup.Length&&after.Length-backup.Length<=ROW,"RECOVERY_BINDING_CHANGED");
        byte[] prefix=new byte[backup.Length],suffix=new byte[after.Length-backup.Length];Buffer.BlockCopy(after,0,prefix,0,prefix.Length);Buffer.BlockCopy(after,backup.Length,suffix,0,suffix.Length);
        Require(Hash(prefix)==Hash(backup)&&Hash(suffix)==intent["deltaHash"]as string,"RECOVERY_BINDING_CHANGED");
      }
      IntPtr file=OpenFile(chain,Parts(request["path"]as string,false),READ_DATA|WRITE_DATA);
      try{
        string full=FinalName(file);Require(FileFingerprint(file,full)==fileId,"FILE_CHANGED");byte[] current=Bytes(file,max);Require(Hash(current)==request["expectedHash"]as string,"HASH_CHANGED");
        try{Write(file,after);chain.Verify();Check(file,full,false,chain.Root);Require(FileFingerprint(file,full)==fileId,"FILE_CHANGED");JournalCreate(journal,id,"complete.json",Serialize(new Dictionary<string,object>{{"recordId",id},{"state","complete"},{"sha256",Hash(after)},{"fileFingerprint",fileId}}));Dictionary<string,object> result=MutationResult(mode,id,Hash(current),Hash(after),fileId,after.Length,false);result["recovered"]=true;return result;}
        catch{throw new Rejected("RECOVERY_REQUIRED",409,id,true);}
      }finally{CloseHandle(file);}
    }
  }
  static Dictionary<string,object> MutationResult(string mode,string id,string before,string after,string fingerprint,int bytes,bool retried){return new Dictionary<string,object>{{"recordId",id},{"beforeHash",before},{"sha256",after},{"fileFingerprint",fingerprint},{"bytes",bytes},{"flushed",true},{"overwritten",mode=="overwrite"},{"appended",mode=="append"},{"alreadyApplied",retried}};}
  static Dictionary<string,object> Handle(Dictionary<string,object> request){
    Supported();Require(request!=null,"INVALID_REQUEST",400);string mode=request.ContainsKey("mode")?request["mode"]as string:null;
    if(mode=="append"||mode=="overwrite")return Mutation(request,mode);
    if(mode=="recover")return Recover(request);
    if(mode=="capacity"){
      Exact(request,new string[]{"mode","root","rootFingerprint"});
      using(Chain chain=new Chain(request["root"]as string)){
        Pin(chain,request["rootFingerprint"]as string,"ROOT_CHANGED");ulong available,total,free;
        Require(GetDiskFreeSpaceExW(chain.Root,out available,out total,out free)&&available<=9007199254740991UL,"CAPACITY_UNAVAILABLE");chain.Verify();
        return new Dictionary<string,object>{{"rootFingerprint",chain.Fingerprint()},{"freeBytes",available}};
      }
    }
    if(mode=="identity"){
      bool parent=request.ContainsKey("parentRoot");Exact(request,parent?new string[]{"mode","root","create","parentRoot","parentFingerprint"}:new string[]{"mode","root","create"});Require(request["create"]is bool,"INVALID_REQUEST",400);
      Chain authority=null;try{if(parent){authority=new Chain(request["parentRoot"]as string);Pin(authority,request["parentFingerprint"]as string,"PARENT_ROOT_CHANGED");string child=NormalRoot(request["root"]as string);Require(child.StartsWith(authority.Root+"\\",StringComparison.OrdinalIgnoreCase),"OUTSIDE_PARENT_ROOT",403);}using(Chain chain=new Chain(request["root"]as string,(bool)request["create"])){if(authority!=null)authority.Verify();return new Dictionary<string,object>{{"rootFingerprint",chain.Fingerprint()},{"created",chain.Created}};}}finally{if(authority!=null)authority.Dispose();}
    }
    if(mode=="inspect"||mode=="create"){
      Exact(request,mode=="inspect"?new string[]{"mode","root","path","text","maxBytes","rootFingerprint"}:new string[]{"mode","root","path","text","kind","rootFingerprint"});string[] parts=Parts(request["path"]as string,false);
      using(Chain chain=new Chain(request["root"]as string)){
        Pin(chain,request["rootFingerprint"]as string,"ROOT_CHANGED");string rootFingerprint=chain.Fingerprint();
        if(mode=="create"){Dictionary<string,object> result=CreateBytes(chain,parts,TextBytes(request["text"]as string,Limit(request["kind"]as string)));result["rootFingerprint"]=rootFingerprint;return result;}
        Require(request["text"]is bool&&request["maxBytes"]is int&&(int)request["maxBytes"]>=0&&(int)request["maxBytes"]<=LOG,"INVALID_OPTIONS",400);bool text=(bool)request["text"];IntPtr file=IntPtr.Zero;
        try{file=OpenFile(chain,parts,READ_DATA);byte[] bytes=Bytes(file,(int)request["maxBytes"]);string full=chain.Current+"\\"+parts[parts.Length-1];Check(file,full,false,chain.Root);chain.Verify();Dictionary<string,object> result=new Dictionary<string,object>{{"missing",false},{"bytes",bytes.Length},{"sha256",Hash(bytes)},{"fileFingerprint",FileFingerprint(file,full)},{"rootFingerprint",rootFingerprint}};if(text)result["text"]=Decode(bytes);return result;}
        catch(Rejected error){if(error.Code!="NOT_FOUND")throw;Dictionary<string,object> result=new Dictionary<string,object>{{"missing",true},{"bytes",0},{"sha256","missing"},{"fileFingerprint","missing"},{"rootFingerprint",rootFingerprint}};if(text)result["text"]="";return result;}
        finally{if(file!=IntPtr.Zero)CloseHandle(file);}
      }
    }
    throw new Rejected("INVALID_OPERATION",400);
  }
  static int Main(){
    Console.InputEncoding=new UTF8Encoding(false,true);Console.OutputEncoding=new UTF8Encoding(false,true);
    try{StringBuilder input=new StringBuilder();char[] buffer=new char[65536];int count;while((count=Console.In.Read(buffer,0,buffer.Length))>0){Require(input.Length<=WIRE-count,"REQUEST_TOO_LARGE",413);input.Append(buffer,0,count);}Dictionary<string,object> request=Serializer().DeserializeObject(input.ToString())as Dictionary<string,object>;Dictionary<string,object> result=Handle(request);result["ok"]=true;Console.Write(Serializer().Serialize(result));}
    catch(Rejected error){Dictionary<string,object> result=new Dictionary<string,object>{{"ok",false},{"code",error.Code},{"status",error.Status}};if(error.Partial){result["partial"]=true;result["recordId"]=error.RecordId;}Console.Write(Serializer().Serialize(result));}
    catch{Console.Write("{\"ok\":false,\"code\":\"NATIVE_FAILURE\",\"status\":409}");}
    return 0;
  }
}
