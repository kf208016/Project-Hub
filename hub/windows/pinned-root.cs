// Native AMD64 NTFS directory identity pin. These handles deny both write and
// delete sharing on every ancestor; ordinary children remain writable.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Security.Cryptography;
using System.Globalization;
using System.IO;
class HubPinnedRoot : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct US {public ushort Length,MaximumLength;public IntPtr Buffer;}
  [StructLayout(LayoutKind.Sequential)] struct OA {public uint Length;public IntPtr RootDirectory,ObjectName;public uint Attributes;public IntPtr SecurityDescriptor,SecurityQualityOfService;}
  [StructLayout(LayoutKind.Sequential)] struct IOS {public IntPtr Status;public UIntPtr Information;}
  [StructLayout(LayoutKind.Sequential)] struct TAG {public uint Attributes,Tag;}
  [StructLayout(LayoutKind.Sequential)] struct FT {public uint Low,High;}
  [StructLayout(LayoutKind.Sequential)] struct FI {public uint Attributes;public FT Creation,Access,Write;public uint VolumeSerial,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct VI {public uint Size,Major,Minor,Build,Platform;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)]public string ServicePack;}
  [DllImport("ntdll.dll",CharSet=CharSet.Unicode)]static extern int RtlGetVersion(ref VI version);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool IsWow64Process2(IntPtr process,out ushort processMachine,out ushort nativeMachine);
  [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
  [DllImport("ntdll.dll")]static extern int NtCreateFile(out IntPtr file,uint access,ref OA attributes,out IOS io,IntPtr allocation,uint fileAttributes,uint sharing,uint disposition,uint options,IntPtr ea,uint eaLength);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateFileW(string name,uint access,uint sharing,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern uint GetFinalPathNameByHandleW(IntPtr file,StringBuilder name,uint length,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern uint GetDriveTypeW(string root);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool GetVolumeInformationByHandleW(IntPtr file,StringBuilder volume,uint volumeLength,out uint serial,out uint component,out uint flags,StringBuilder filesystem,uint filesystemLength);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandleEx(IntPtr file,int kind,out TAG info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandle(IntPtr file,out FI info);
  [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr file);
  readonly List<IntPtr> handles=new List<IntPtr>();readonly List<string> names=new List<string>();readonly string root,fingerprint;bool disposed;
  static void Require(bool ok){if(!ok)throw new IOException("Directory identity pin rejected");}
  void RequireLive(){Require(!disposed&&handles.Count>0&&handles.Count==names.Count);}
  static string Hash(byte[] bytes){using(SHA256 sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
  static bool Component(string value){if(String.IsNullOrEmpty(value)||value=="."||value==".."||value.Length>255||value.EndsWith(" ")||value.EndsWith("."))return false;foreach(char c in value)if(c<32||c==127||"\\/:*?\"<>|".IndexOf(c)>=0)return false;return true;}
  void Check(IntPtr handle,string expected){TAG tag;Require(GetFileInformationByHandleEx(handle,9,out tag,8)&&(tag.Attributes&0x400)==0&&(tag.Attributes&0x10)!=0);StringBuilder name=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(handle,name,32768,0);Require(n>0&&n<32768&&String.Equals(name.ToString(),"\\\\?\\"+expected,StringComparison.OrdinalIgnoreCase));}
  IntPtr Relative(IntPtr parent,string component){IntPtr text=Marshal.StringToHGlobalUni(component),unicode=IntPtr.Zero,file=IntPtr.Zero;try{US u=new US();u.Buffer=text;u.Length=(ushort)(component.Length*2);u.MaximumLength=(ushort)(u.Length+2);unicode=Marshal.AllocHGlobal(16);Marshal.StructureToPtr(u,unicode,false);OA a=new OA();a.Length=48;a.RootDirectory=parent;a.ObjectName=unicode;a.Attributes=0x1040;IOS io;int status=NtCreateFile(out file,0x1000a0,ref a,out io,IntPtr.Zero,0x80,1,1,0x200121,IntPtr.Zero,0);if(status!=0){if(file!=IntPtr.Zero&&file!=new IntPtr(-1))CloseHandle(file);throw new IOException("Directory pin could not open ancestor");}return file;}finally{if(unicode!=IntPtr.Zero)Marshal.FreeHGlobal(unicode);Marshal.FreeHGlobal(text);}}
  string CurrentFingerprint(){RequireLive();FI info;Require(GetFileInformationByHandle(handles[handles.Count-1],out info));ulong index=((ulong)info.IndexHigh<<32)|info.IndexLow;return Hash(Encoding.UTF8.GetBytes(root+"\n"+info.VolumeSerial.ToString(CultureInfo.InvariantCulture)+"\n"+index.ToString(CultureInfo.InvariantCulture)));}
  public HubPinnedRoot(string requested,string expected){VI version=new VI();version.Size=(uint)Marshal.SizeOf(typeof(VI));ushort machine,native;Require(IntPtr.Size==8&&RtlGetVersion(ref version)==0&&version.Major==10&&version.Minor==0&&version.Build==26200&&IsWow64Process2(GetCurrentProcess(),out machine,out native)&&machine==0&&native==0x8664);root=requested==null?null:requested.Replace('/','\\').TrimEnd('\\');fingerprint=expected;Require(root!=null&&root.Length>3&&root.Length<=32768&&Char.IsLetter(root[0])&&root[1]==':'&&root[2]=='\\'&&expected!=null&&expected.Length==64&&GetDriveTypeW(root.Substring(0,3))==3);string[] parts=root.Substring(3).Split('\\');Require(parts.Length<=128);foreach(string part in parts)Require(Component(part));try{string current=root.Substring(0,3);IntPtr drive=CreateFileW(current,0x1000a0,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero);Require(drive!=IntPtr.Zero&&drive!=new IntPtr(-1));handles.Add(drive);names.Add(current);Check(drive,current);uint serial,component,flags;StringBuilder volume=new StringBuilder(260),fs=new StringBuilder(32);Require(GetVolumeInformationByHandleW(drive,volume,260,out serial,out component,out flags,fs,32)&&fs.ToString()=="NTFS");foreach(string part in parts){IntPtr next=Relative(handles[handles.Count-1],part);handles.Add(next);current=current.TrimEnd('\\')+"\\"+part;names.Add(current);Check(next,current);}Verify();}catch{Dispose();throw;}}
  public void Verify(){RequireLive();for(int i=0;i<handles.Count;i++)Check(handles[i],names[i]);Require(CurrentFingerprint()==fingerprint);}
  public void Dispose(){if(disposed)return;disposed=true;for(int i=handles.Count-1;i>=0;i--)CloseHandle(handles[i]);handles.Clear();names.Clear();}
}
