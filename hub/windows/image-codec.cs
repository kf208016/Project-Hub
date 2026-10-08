// Decodes bytes only. WIC never receives a caller-controlled filesystem path.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Web.Script.Serialization;
using System.IO.Pipes;
using System.Threading;
using System.Text;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.IO.Compression;
using System.Security.AccessControl;
using System.Security.Principal;

[ComImport, Guid("ec5ec8a9-c395-4314-9c77-54d7a935ff70"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface Factory {
  void Filename();
  void CreateDecoderFromStream(IStream stream, IntPtr vendor, uint options, out Decoder decoder);
  void FileHandle(); void ComponentInfo(); void DecoderByFormat();
  void CreateEncoder(ref Guid format, IntPtr vendor, out Encoder encoder);
  void Palette();
  void CreateFormatConverter(out Converter converter);
}
[ComImport, Guid("9edde9e7-8dee-47ea-99df-e6faf2ed44bf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface Decoder {
  void QueryCapability(); void Initialize(); void GetContainerFormat(out Guid format);
  void DecoderInfo(); void Palette(); void Metadata(); void Preview(); void ColorContexts(); void Thumbnail();
  void GetFrameCount(out uint count); void GetFrame(uint index, out Source frame);
}
[ComImport, Guid("00000120-a8f2-4877-ba0a-fd2b6645fb94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface Source {
  void GetSize(out uint width, out uint height); void GetPixelFormat(out Guid format);
  void GetResolution(out double x, out double y); void Palette();
  void CopyPixels(IntPtr rect, uint stride, uint size, [Out,MarshalAs(UnmanagedType.LPArray,SizeParamIndex=2)] byte[] bytes);
}
[ComImport, Guid("00000301-a8f2-4877-ba0a-fd2b6645fb94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface Converter {
  void GetSize(out uint width, out uint height); void GetPixelFormat(out Guid format);
  void GetResolution(out double x, out double y); void Palette();
  void CopyPixels(IntPtr rect, uint stride, uint size, [Out,MarshalAs(UnmanagedType.LPArray,SizeParamIndex=2)] byte[] bytes);
  void Initialize(Source source, ref Guid format, uint dither, IntPtr palette, double alpha, uint paletteType);
  void CanConvert();
}
[ComImport, Guid("00000103-a8f2-4877-ba0a-fd2b6645fb94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface Encoder {
  void Initialize(IStream stream, uint cache); void ContainerFormat(); void EncoderInfo(); void ColorContexts();
  void Palette(); void Thumbnail(); void Preview();
  void CreateNewFrame(out FrameEncoder frame, out IntPtr options); void Commit(); void Metadata();
}
[ComImport, Guid("00000105-a8f2-4877-ba0a-fd2b6645fb94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface FrameEncoder {
  void Initialize(IntPtr options); void SetSize(uint width, uint height); void SetResolution(double x, double y);
  void SetPixelFormat(ref Guid format); void ColorContexts(); void Palette(); void Thumbnail();
  void WritePixels(uint lines, uint stride, uint size, [MarshalAs(UnmanagedType.LPArray,SizeParamIndex=2)] byte[] bytes); void WriteSource(); void Commit(); void Metadata();
}
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
class MemoryComStream : IStream {
  readonly MemoryStream stream; readonly bool writable;
  public MemoryComStream(byte[] input) { stream = new MemoryStream(input, false); writable = false; }
  public MemoryComStream() { stream = new MemoryStream(); writable = true; }
  public byte[] Bytes() { return stream.ToArray(); }
  public void Read(byte[] b, int n, IntPtr read) { int count=stream.Read(b,0,n); if(read!=IntPtr.Zero)Marshal.WriteInt32(read,count); }
  public void Write(byte[] b, int n, IntPtr written) { if(!writable||stream.Position+n>140L*1024*1024)throw new IOException("OUTPUT_LIMIT");stream.Write(b,0,n);if(written!=IntPtr.Zero)Marshal.WriteInt32(written,n); }
  public void Seek(long offset,int origin,IntPtr position) { long p=stream.Seek(offset,(SeekOrigin)origin);if(position!=IntPtr.Zero)Marshal.WriteInt64(position,p); }
  public void SetSize(long n) { if(!writable||n<0||n>140L*1024*1024)throw new IOException("OUTPUT_LIMIT");stream.SetLength(n); }
  public void CopyTo(IStream other,long count,IntPtr read,IntPtr written) { throw new NotSupportedException(); }
  public void Commit(int flags) { }
  public void Revert() { throw new NotSupportedException(); }
  public void LockRegion(long offset,long count,int flags) { throw new NotSupportedException(); }
  public void UnlockRegion(long offset,long count,int flags) { throw new NotSupportedException(); }
  public void Stat(out System.Runtime.InteropServices.ComTypes.STATSTG stat,int flags) { stat=new System.Runtime.InteropServices.ComTypes.STATSTG();stat.type=2;stat.cbSize=stream.Length;stat.grfMode=writable?2:0; }
  public void Clone(out IStream other) { throw new NotSupportedException(); }
}
class HubImageCodec {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long UserTime,JobTime;public uint Flags;public UIntPtr Min,Max;public uint Active;public UIntPtr Affinity;public uint Priority,Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimits Basic;public Io Io;public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
  [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr CreateJobObjectW(IntPtr security,IntPtr name);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limits limits,uint size);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateJobObject(IntPtr job,uint code);
  [StructLayout(LayoutKind.Sequential)]struct Startup {public int cb;public IntPtr reserved,desktop,title;public int x,y,xSize,ySize,xChars,yChars,fill,flags;public short show,reservedSize;public IntPtr reservedBytes,input,output,error;}
  [StructLayout(LayoutKind.Sequential)]struct StartupEx {public Startup info;public IntPtr attributes;}
  [StructLayout(LayoutKind.Sequential)]struct ProcessInfo {public IntPtr process,thread;public uint pid,tid;}
  [StructLayout(LayoutKind.Sequential,Pack=4)]struct FileInfo {public uint attributes;public long creation,access,write;public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateFileW(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandle(IntPtr file,out FileInfo info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern uint GetFinalPathNameByHandleW(IntPtr file,StringBuilder name,uint size,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern uint GetDriveTypeW(string root);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx startup,out ProcessInfo process);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")]static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",SetLastError=true)]static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)]static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
  [DllImport("ole32.dll")]static extern int CoCreateInstance(ref Guid clsid,IntPtr outer,uint context,ref Guid iid,out Factory factory);
  static readonly Guid Png=new Guid("1b7cfaf4-713f-473c-bbcd-6137425faeaf");
  static readonly Guid Bgra=new Guid("6fddc324-4e03-4bfe-b185-3d77768dc90f");
  static readonly uint[] CrcTable=MakeCrc();
  static uint[] MakeCrc(){uint[] table=new uint[256];for(uint n=0;n<256;n++){uint c=n;for(int k=0;k<8;k++)c=(c&1)!=0?0xedb88320^(c>>1):c>>1;table[n]=c;}return table;}
  static uint U32(byte[] b,int at){return ((uint)b[at]<<24)|((uint)b[at+1]<<16)|((uint)b[at+2]<<8)|b[at+3];}
  static uint Crc(byte[] b,int at,int count){uint c=0xffffffff;for(int n=0;n<count;n++)c=CrcTable[(c^b[at+n])&255]^(c>>8);return c^0xffffffff;}
  static void ValidatePng(byte[] b) {
    byte[] magic={137,80,78,71,13,10,26,10};bool png=b.Length>=8;for(int n=0;n<8&&png;n++)png=b[n]==magic[n];if(!png)return;
    int at=8,depth=0,color=0,interlace=0;uint width=0,height=0;bool header=false,data=false,ended=false,palette=false,afterData=false;
    using(MemoryStream compressed=new MemoryStream()){
      while(at<b.Length){
        if(b.Length-at<12)throw new InvalidDataException("PNG_STRUCTURE");uint len=U32(b,at);if(len>50*1024*1024||len>(uint)(b.Length-at-12))throw new InvalidDataException("PNG_STRUCTURE");int size=(int)len;string type=Encoding.ASCII.GetString(b,at+4,4);
        for(int n=at+4;n<at+8;n++)if(!((b[n]>=65&&b[n]<=90)||(b[n]>=97&&b[n]<=122)))throw new InvalidDataException("PNG_STRUCTURE");
        if((b[at+6]&32)!=0||Crc(b,at+4,size+4)!=U32(b,at+8+size))throw new InvalidDataException("PNG_CHECKSUM");
        if(!header&&type!="IHDR")throw new InvalidDataException("PNG_STRUCTURE");
        if(type=="IHDR"){
          if(header||size!=13)throw new InvalidDataException("PNG_STRUCTURE");header=true;width=U32(b,at+8);height=U32(b,at+12);depth=b[at+16];color=b[at+17];interlace=b[at+20];
          if(width==0||height==0||width>32768||height>32768||(ulong)width*height>32000000)throw new InvalidDataException("PIXEL_LIMIT");
          bool valid=(color==0&&(depth==1||depth==2||depth==4||depth==8||depth==16))||(color==2&&(depth==8||depth==16))||(color==3&&(depth==1||depth==2||depth==4||depth==8))||((color==4||color==6)&&(depth==8||depth==16));
          if(!valid||b[at+18]!=0||b[at+19]!=0||interlace>1)throw new InvalidDataException("PNG_STRUCTURE");
        }else if(type=="PLTE"){
          if(palette||data||size==0||size%3!=0||size>768||color==0||color==4||(color==3&&size/3>(1<<depth)))throw new InvalidDataException("PNG_STRUCTURE");palette=true;
        }else if(type=="IDAT"){
          if(afterData||(color==3&&!palette))throw new InvalidDataException("PNG_STRUCTURE");data=true;compressed.Write(b,at+8,size);
        }else if(type=="IEND"){
          if(!data||size!=0||at+12!=b.Length)throw new InvalidDataException("PNG_STRUCTURE");ended=true;break;
        }else{if((b[at+4]&32)==0)throw new InvalidDataException("PNG_STRUCTURE");if(data)afterData=true;}
        at+=size+12;
      }
      if(!ended||compressed.Length<6)throw new InvalidDataException("PNG_STRUCTURE");byte[] z=compressed.GetBuffer();int count=(int)compressed.Length;
      if((z[0]&15)!=8||(z[0]>>4)>7||((z[0]<<8)+z[1])%31!=0||(z[1]&32)!=0)throw new InvalidDataException("PNG_DEFLATE");
      int channels=color==2?3:color==4?2:color==6?4:1,bits=channels*depth;long expected=0;List<long> filters=new List<long>();
      int[] x={0,4,0,2,0,1,0},y={0,0,4,0,2,0,1},dx={8,8,4,4,2,2,1},dy={8,8,8,4,4,2,2};
      for(int pass=0;pass<(interlace==0?1:7);pass++){
        long w=interlace==0?width:width<=x[pass]?0:((long)width-x[pass]+dx[pass]-1)/dx[pass],h=interlace==0?height:height<=y[pass]?0:((long)height-y[pass]+dy[pass]-1)/dy[pass];if(w==0||h==0)continue;long row=1+(w*bits+7)/8;
        for(long r=0;r<h;r++){filters.Add(expected);expected+=row;}
      }
      long total=0;uint a=1,c=0;int filter=0;
      using(MemoryStream raw=new MemoryStream(z,2,count-6,false))using(DeflateStream deflate=new DeflateStream(raw,CompressionMode.Decompress)){
        byte[] chunk=new byte[65536];int n;while((n=deflate.Read(chunk,0,chunk.Length))>0){if(total+n>expected)throw new InvalidDataException("PNG_DEFLATE");
          while(filter<filters.Count&&filters[filter]<total+n){int offset=(int)(filters[filter]-total);if(offset<0||chunk[offset]>4)throw new InvalidDataException("PNG_FILTER");filter++;}
          for(int begin=0;begin<n;begin+=5552){int end=Math.Min(n,begin+5552);for(int k=begin;k<end;k++){a+=chunk[k];c+=a;}a%=65521;c%=65521;}total+=n;
        }
      }
      if(total!=expected||filter!=filters.Count||((c<<16)|a)!=U32(z,count-4))throw new InvalidDataException("PNG_DEFLATE");
    }
  }
  static void Release(object value) { if(value!=null&&Marshal.IsComObject(value))Marshal.FinalReleaseComObject(value); }
  static string Format(Guid value) {
    if(value==Png)return "png";
    if(value==new Guid("19e4a5aa-5662-4fc5-a0c0-1758028e1057"))return "jpeg";
    if(value==new Guid("1f8a5601-7d4d-4cbd-9c82-1bc8d4eeb9a5"))return "gif";
    if(value==new Guid("e094b0e2-67f2-45b3-b0ea-115337ca7cf3"))return "webp";
    if(value==new Guid("e1e62521-6787-405b-a339-500715b5763f"))return "heic";
    throw new InvalidDataException("FORMAT_UNSUPPORTED");
  }
  static void Header(object value) { byte[] text=System.Text.Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(value)+"\n");Console.OpenStandardOutput().Write(text,0,text.Length); }
  static void Require(bool value,string code) {if(!value)throw new IOException(code);}
  static List<IntPtr> PinDirectory(string folder) {
    List<IntPtr> pins=new List<IntPtr>();
    try {
      Require(folder!=null&&folder.Length>3&&folder.Length<32768&&folder[1]==':'&&folder[2]=='\\'&&Path.GetFullPath(folder)==folder&&GetDriveTypeW(folder.Substring(0,3))==3,"BACKEND_PATH_INVALID");
      string current=folder.Substring(0,3);string[] parts=folder.Substring(3).Split('\\');
      for(int i=-1;i<parts.Length;i++){
        if(i>=0)current=current.TrimEnd('\\')+"\\"+parts[i];IntPtr dir=CreateFileW(current,0x80,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero);Require(dir!=IntPtr.Zero&&dir!=new IntPtr(-1),"BACKEND_PIN_FAILED");pins.Add(dir);
        FileInfo info;StringBuilder real=new StringBuilder(32768);Require(GetFileInformationByHandle(dir,out info)&&(info.attributes&0x400)==0&&(info.attributes&0x10)!=0&&GetFinalPathNameByHandleW(dir,real,32768,0)>0&&String.Equals(real.ToString(),"\\\\?\\"+current,StringComparison.OrdinalIgnoreCase),"BACKEND_PATH_INVALID");
      }
      return pins;
    }catch{for(int i=pins.Count-1;i>=0;i--)CloseHandle(pins[i]);throw;}
  }
  static byte[] RunOwned(string file,string args,byte[] input,int max) {
    IntPtr job=IntPtr.Zero,attributes=IntPtr.Zero,handles=IntPtr.Zero,env=IntPtr.Zero,readInput=IntPtr.Zero;ProcessInfo process=new ProcessInfo();FileStream spool=null;List<IntPtr> spoolPins=null;
    using(AnonymousPipeServerStream stdin=new AnonymousPipeServerStream(PipeDirection.Out,HandleInheritability.Inheritable))
    using(AnonymousPipeServerStream stdout=new AnonymousPipeServerStream(PipeDirection.In,HandleInheritability.Inheritable))
    using(AnonymousPipeServerStream stderr=new AnonymousPipeServerStream(PipeDirection.In,HandleInheritability.Inheritable)) {
      MemoryStream output=new MemoryStream();bool failed=false;
      try {
        if(input!=null) {
          // HEIF grids and late metadata need seeking. The caller still supplies
          // bytes only; this private CreateNew spool is never named in FFmpeg argv.
          string folder=Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
          spoolPins=PinDirectory(folder);
          string temp=Path.Combine(folder,"heic-source-"+Guid.NewGuid().ToString("D")+".tmp");
          SecurityIdentifier user=WindowsIdentity.GetCurrent().User;FileSecurity security=new FileSecurity();security.SetOwner(user);security.SetAccessRuleProtection(true,false);
          security.AddAccessRule(new FileSystemAccessRule(user,FileSystemRights.FullControl,AccessControlType.Allow));security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),FileSystemRights.FullControl,AccessControlType.Allow));
          spool=new FileStream(temp,FileMode.CreateNew,FileSystemRights.FullControl,FileShare.None,65536,FileOptions.DeleteOnClose,security);spool.Write(input,0,input.Length);spool.Flush(true);spool.Position=0;
          // Only read rights reach the child, even though our spool creator wrote it.
          Require(DuplicateHandle(GetCurrentProcess(),spool.SafeFileHandle.DangerousGetHandle(),GetCurrentProcess(),out readInput,0x120089,true,0),"BACKEND_SPOOL_FAILED");
        }
        job=CreateJobObjectW(IntPtr.Zero,IntPtr.Zero);Limits limits=new Limits();limits.Basic.Flags=0x2308;limits.Basic.Active=1;limits.ProcessMemory=new UIntPtr(512U*1024U*1024U);limits.JobMemory=limits.ProcessMemory;
        Require(job!=IntPtr.Zero&&SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))),"BACKEND_JOB_UNAVAILABLE");
        StartupEx si=new StartupEx();si.info.cb=Marshal.SizeOf(typeof(StartupEx));si.info.flags=0x100;
        IntPtr[] std={new IntPtr(Int64.Parse(stdin.GetClientHandleAsString())),new IntPtr(Int64.Parse(stdout.GetClientHandleAsString())),new IntPtr(Int64.Parse(stderr.GetClientHandleAsString()))};
        if(readInput!=IntPtr.Zero)std[0]=readInput;
        si.info.input=std[0];si.info.output=std[1];si.info.error=std[2];IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);attributes=Marshal.AllocHGlobal(size);
        Require(InitializeProcThreadAttributeList(attributes,1,0,ref size),"BACKEND_JOB_UNAVAILABLE");handles=Marshal.AllocHGlobal(IntPtr.Size*3);for(int i=0;i<3;i++)Marshal.WriteIntPtr(handles,i*IntPtr.Size,std[i]);
        Require(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"BACKEND_JOB_UNAVAILABLE");si.attributes=attributes;
        string root=Environment.GetEnvironmentVariable("SystemRoot")??"C:\\Windows";env=Marshal.StringToHGlobalUni("SystemRoot="+root+"\0WINDIR="+root+"\0\0");
        Require(CreateProcessW(file,new StringBuilder("\""+file+"\" "+args),IntPtr.Zero,IntPtr.Zero,true,0x08080404,env,Path.GetDirectoryName(file),ref si,out process),"BACKEND_START_FAILED");
        Require(AssignProcessToJobObject(job,process.process),"BACKEND_JOB_UNAVAILABLE");
        stdin.DisposeLocalCopyOfClientHandle();stdout.DisposeLocalCopyOfClientHandle();stderr.DisposeLocalCopyOfClientHandle();
        Thread send=new Thread(delegate(){try{stdin.Dispose();}catch{failed=true;}});
        Thread receive=new Thread(delegate(){try{byte[] b=new byte[65536];int n;while((n=stdout.Read(b,0,b.Length))>0){if(output.Length+n>max)throw new IOException();output.Write(b,0,n);}}catch{failed=true;TerminateJobObject(job,125);}});
        Thread errors=new Thread(delegate(){try{byte[] b=new byte[4096];int total=0,n;while((n=stderr.Read(b,0,b.Length))>0){total+=n;if(total>65536)throw new IOException();}}catch{failed=true;TerminateJobObject(job,125);}});
        send.IsBackground=receive.IsBackground=errors.IsBackground=true;send.Start();receive.Start();errors.Start();Require(ResumeThread(process.thread)!=0xffffffff,"BACKEND_START_FAILED");
        if(WaitForSingleObject(process.process,8000)!=0)throw new IOException("BACKEND_TIMEOUT");uint exit;Require(GetExitCodeProcess(process.process,out exit)&&exit==0,"BACKEND_DECODE_FAILED");
        Require(send.Join(1000)&&receive.Join(1000)&&errors.Join(1000)&&!failed,"BACKEND_IO_FAILED");return output.ToArray();
      } finally {
        if(job!=IntPtr.Zero){TerminateJobObject(job,125);CloseHandle(job);}if(process.process!=IntPtr.Zero){TerminateProcess(process.process,125);WaitForSingleObject(process.process,2000);CloseHandle(process.process);}if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);
        if(readInput!=IntPtr.Zero)CloseHandle(readInput);if(spool!=null)spool.Dispose();
        if(spoolPins!=null)for(int i=spoolPins.Count-1;i>=0;i--)CloseHandle(spoolPins[i]);
        if(attributes!=IntPtr.Zero){DeleteProcThreadAttributeList(attributes);Marshal.FreeHGlobal(attributes);}if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);
      }
    }
  }
  static byte[] Fallback(string file,string hash,string version,byte[] input) {
    Require(version=="9.0.2-essentials_build-www.gyan.dev"&&System.Text.RegularExpressions.Regex.IsMatch(hash,"^[a-f0-9]{64}$"),"BACKEND_CONFIG_INVALID");
    Require(file!=null&&file.Length>3&&file.Length<32768&&file[1]==':'&&file[2]=='\\'&&file.Substring(2).IndexOf(':')<0&&file.IndexOf('"')<0&&Path.GetFullPath(file)==file&&GetDriveTypeW(file.Substring(0,3))==3,"BACKEND_PATH_INVALID");
    List<IntPtr> pins=PinDirectory(Path.GetDirectoryName(file));
    try {
      // Deny writes and deletion until both version and decoder child have exited.
      using(FileStream executable=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read)) {
        FileInfo info;Require(GetFileInformationByHandle(executable.SafeFileHandle.DangerousGetHandle(),out info)&&(info.attributes&0x410)==0&&info.links==1,"BACKEND_PATH_INVALID");
        StringBuilder finalPath=new StringBuilder(32768);Require(GetFinalPathNameByHandleW(executable.SafeFileHandle.DangerousGetHandle(),finalPath,32768,0)>0&&String.Equals(finalPath.ToString(),"\\\\?\\"+file,StringComparison.OrdinalIgnoreCase),"BACKEND_PATH_INVALID");
        Require(executable.Length>256&&executable.Length<512L*1024*1024,"BACKEND_BINARY_INVALID");byte[] header=new byte[64];Require(executable.Read(header,0,64)==64&&header[0]==77&&header[1]==90,"BACKEND_BINARY_INVALID");int pe=BitConverter.ToInt32(header,60);Require(pe>0&&pe<executable.Length-8,"BACKEND_BINARY_INVALID");executable.Position=pe;header=new byte[6];Require(executable.Read(header,0,6)==6&&header[0]==80&&header[1]==69&&header[2]==0&&header[3]==0&&header[4]==0x64&&header[5]==0x86,"BACKEND_BINARY_INVALID");
        executable.Position=0;using(SHA256 sha=SHA256.Create())Require(BitConverter.ToString(sha.ComputeHash(executable)).Replace("-","").ToLowerInvariant()==hash,"BACKEND_HASH_MISMATCH");
        string actual=Encoding.UTF8.GetString(RunOwned(file,"-hide_banner -version",null,16384));Require(actual.StartsWith("ffmpeg version "+version+" "),"BACKEND_VERSION_MISMATCH");
        byte[] png=RunOwned(file,"-hide_banner -loglevel error -nostdin -max_alloc 134217728 -threads 1 -protocol_whitelist fd,pipe -format_whitelist mov -codec_whitelist hevc -f mov -enable_drefs 0 -use_absolute_path 0 -ignore_editlist 1 -noautorotate -c:v hevc -max_pixels 32000000 -fd 0 -blocksize 65536 -i fd: -an -sn -dn -frames:v 1 -threads 1 -map_metadata -1 -pix_fmt rgba -c:v png -f image2pipe -protocol_whitelist pipe pipe:1",input,140*1024*1024);Require(png.Length>8,"BACKEND_EMPTY_OUTPUT");return png;
      }
    } finally {for(int i=pins.Count-1;i>=0;i--)CloseHandle(pins[i]);}
  }
  [STAThread] static int Main(string[] args) {
    IntPtr job=IntPtr.Zero;Factory factory=null;Decoder decoder=null;Source frame=null;Converter converter=null;Encoder encoder=null;FrameEncoder encoded=null;IntPtr options=IntPtr.Zero;
    byte[] original=null;string knownFormat=null;uint knownWidth=0,knownHeight=0,knownFrames=0;
    try {
      // A separate process bounds native codec allocations as well as managed buffers.
      job=CreateJobObjectW(IntPtr.Zero,IntPtr.Zero);Limits limits=new Limits();limits.Basic.Flags=0x00000306;limits.Basic.UserTime=150000000;limits.Basic.JobTime=150000000;limits.ProcessMemory=new UIntPtr(512U*1024U*1024U);limits.JobMemory=limits.ProcessMemory;
      if(job==IntPtr.Zero)throw new IOException("MEMORY_BOUND_CREATE");
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))))throw new IOException("MEMORY_BOUND_SET");
      if(!AssignProcessToJobObject(job,GetCurrentProcess()))throw new IOException("MEMORY_BOUND_ASSIGN");
      MemoryStream input=new MemoryStream();byte[] chunk=new byte[65536];Stream stdin=Console.OpenStandardInput();int n;
      while((n=stdin.Read(chunk,0,chunk.Length))>0){if(input.Length+n>50L*1024*1024)throw new InvalidDataException("INPUT_LIMIT");input.Write(chunk,0,n);}
      if(input.Length==0)throw new InvalidDataException("EMPTY_IMAGE");
      Guid clsid=new Guid("cacaf262-9370-4615-a13b-9f5539da4c0a"),iid=new Guid("ec5ec8a9-c395-4314-9c77-54d7a935ff70");
      Marshal.ThrowExceptionForHR(CoCreateInstance(ref clsid,IntPtr.Zero,1,ref iid,out factory));
      original=input.ToArray();input.Dispose();ValidatePng(original);MemoryComStream source=new MemoryComStream(original);factory.CreateDecoderFromStream(source,IntPtr.Zero,0,out decoder);
      Guid container;decoder.GetContainerFormat(out container);string format=Format(container);uint frames;decoder.GetFrameCount(out frames);
      if(frames==0||frames>4096)throw new InvalidDataException("FRAME_LIMIT");
      decoder.GetFrame(0,out frame);uint width,height;frame.GetSize(out width,out height);
      if(width==0||height==0||width>32768||height>32768||(ulong)width*height>32000000)throw new InvalidDataException("PIXEL_LIMIT");
      knownFormat=format;knownWidth=width;knownHeight=height;knownFrames=frames;
      factory.CreateFormatConverter(out converter);Guid pixel=Bgra;converter.Initialize(frame,ref pixel,0,IntPtr.Zero,0,0);
      uint stride=checked(width*4),size=checked(stride*height);byte[] pixels=new byte[size];converter.CopyPixels(IntPtr.Zero,stride,size,pixels);
      byte[] output=null;
      if(format!="png"&&format!="jpeg") {
        MemoryComStream destination=new MemoryComStream();Guid png=Png;factory.CreateEncoder(ref png,IntPtr.Zero,out encoder);encoder.Initialize(destination,2);
        encoder.CreateNewFrame(out encoded,out options);encoded.Initialize(options);encoded.SetSize(width,height);encoded.SetResolution(96,96);pixel=Bgra;encoded.SetPixelFormat(ref pixel);
        if(pixel!=Bgra)throw new InvalidDataException("PNG_PIXEL_FORMAT");
        encoded.WritePixels(height,stride,size,pixels);encoded.Commit();encoder.Commit();output=destination.Bytes();
      }
      Header(new {ok=true,format=format,width=width,height=height,frames=frames,convertedLength=output==null?0:output.Length});
      if(output!=null)Console.OpenStandardOutput().Write(output,0,output.Length);
      return 0;
    } catch(Exception error) {
      // No input bytes, filenames, codec paths or user metadata enter errors.
      string code=error is InvalidDataException||error is IOException?error.Message:"DECODE_FAILED";
      if(error.HResult==unchecked((int)0xC00D5212)||error.HResult==unchecked((int)0x88982F50))code="CODEC_UNAVAILABLE";
      if(code=="CODEC_UNAVAILABLE"&&knownFormat=="heic"&&args.Length==3) {
        try {byte[] output=Fallback(args[0],args[1],args[2],original);Header(new {ok=true,format="heic",width=knownWidth,height=knownHeight,frames=knownFrames,convertedLength=output.Length,backend="ffmpeg",backendVersion=args[2]});Console.OpenStandardOutput().Write(output,0,output.Length);return 0;}
        catch(Exception fallback){code=fallback is IOException?fallback.Message:"BACKEND_FAILED";}
      }
      if(!System.Text.RegularExpressions.Regex.IsMatch(code,"^[A-Z_]{1,64}$"))code="DECODE_FAILED";
      Header(new {ok=false,code=code});return 0;
    } finally {if(options!=IntPtr.Zero)Marshal.Release(options);Release(encoded);Release(encoder);Release(converter);Release(frame);Release(decoder);Release(factory);if(job!=IntPtr.Zero)CloseHandle(job);}
  }
}
