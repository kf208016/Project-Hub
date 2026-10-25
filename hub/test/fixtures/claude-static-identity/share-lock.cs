// Test-only entry point; production Main never accepts these paths or operations.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

class ClaudeStaticShareSelfTest {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string name,IntPtr security);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateHardLinkW(string name,string existing,IntPtr security);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool DeleteFileW(string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool MoveFileExW(string from,string to,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileMappingW(SafeFileHandle file,IntPtr security,uint protection,uint high,uint low,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr MapViewOfFile(IntPtr map,uint access,uint high,uint low,UIntPtr length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UnmapViewOfFile(IntPtr view);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  static readonly List<object> cases=new List<object>();
  static readonly List<object> observations=new List<object>();
  static void Check(bool value,string name) { if(!value)throw new Exception(name); cases.Add(new Dictionary<string,object>{{"case",name},{"passed",true}}); }
  static bool OpenDenied(string path,uint access) {
    using(SafeFileHandle file=HubClaudeStaticIdentity.CreateFileW(path,access,7,IntPtr.Zero,3,0,IntPtr.Zero)) {
      int error=Marshal.GetLastWin32Error(); observations.Add(new {operation="open-alias",access,opened=!file.IsInvalid,nativeError=file.IsInvalid?error:0});return file.IsInvalid && error==32;
    }
  }
  static bool PinDenied(string path) {
    try {using(HubClaudeStaticIdentity.HeldFile held=new HubClaudeStaticIdentity.HeldFile(path,4096)){}return false;}
    catch(HubClaudeStaticIdentity.Rejected error){return error.Code=="STATIC_FILE_OPEN_FAILED" && error.NativeError==32;}
  }
  static void WriteNew(string path) {using(FileStream file=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None)){byte[] bytes=Encoding.ASCII.GetBytes("owned-static-share-fixture\n");file.Write(bytes,0,bytes.Length);}}
  static void Run(string root) {
    string source=Path.Combine(root,"source.bin"),alias=Path.Combine(root,"alias.bin"),renamed=Path.Combine(root,"renamed.bin"),extra=Path.Combine(root,"extra.bin"),ads=Path.Combine(root,"ads.bin");
    WriteNew(source);bool linked=CreateHardLinkW(alias,source,IntPtr.Zero);int linkError=Marshal.GetLastWin32Error();
    if(!linked)throw new System.ComponentModel.Win32Exception(linkError,"create-owned-hardlink");Check(true,"create-owned-hardlink");
    using(HubPinnedRoot parent=HubClaudeStaticIdentity.PinParent(source))
    using(HubClaudeStaticIdentity.HeldFile held=new HubClaudeStaticIdentity.HeldFile(source,4096)) {
      string hash=HubClaudeStaticIdentity.Hash(held.Stream);
      using(HubClaudeStaticIdentity.HeldFile other=new HubClaudeStaticIdentity.HeldFile(alias,4096)) {
        Check(HubClaudeStaticIdentity.Same(held.Before,other.Before) && held.Before.Links==2,"aliases-same-file-id-and-two-links");
        Check(HubClaudeStaticIdentity.Hash(other.Stream)==hash,"alias-read-allowed");
      }
      Check(OpenDenied(alias,0x40000000),"alias-write-open-sharing-violation");
      Check(OpenDenied(source,0x10000),"held-path-delete-open-sharing-violation");
      bool sourceDeleted=DeleteFileW(source);int sourceDeleteError=Marshal.GetLastWin32Error();Check(!sourceDeleted && sourceDeleteError==32,"held-path-delete-sharing-violation");
      bool sourceRenamed=MoveFileExW(source,renamed,0);int sourceRenameError=Marshal.GetLastWin32Error();Check(!sourceRenamed && sourceRenameError==32,"held-path-rename-sharing-violation");
      // NTFS DELETE sharing is link-specific. Other names are not claimed frozen.
      using(SafeFileHandle deleteAlias=HubClaudeStaticIdentity.CreateFileW(alias,0x10000,7,IntPtr.Zero,3,0,IntPtr.Zero))
        Check(!deleteAlias.IsInvalid,"unheld-alias-delete-open-observed");
      bool renamedOk=MoveFileExW(alias,renamed,0);int renameError=Marshal.GetLastWin32Error();
      observations.Add(new {operation="rename-unheld-alias",succeeded=renamedOk,nativeError=renamedOk?0:renameError});
      Check(renamedOk || renameError==32,"unheld-alias-rename-measured");
      held.Verify();Check(HubClaudeStaticIdentity.Hash(held.Stream)==hash,"unheld-alias-rename-keeps-held-bytes-and-id");
      if(renamedOk)Check(MoveFileExW(renamed,alias,0),"owned-alias-name-restored");
      held.Verify();parent.Verify();Check(HubClaudeStaticIdentity.Hash(held.Stream)==hash,"identity-size-linkcount-hash-stable");
      HubClaudeStaticIdentity.FI altered=held.Before;altered.Links++;Check(!HubClaudeStaticIdentity.Same(held.Before,altered),"changed-linkcount-rejected");
      altered=held.Before;altered.IndexLow++;Check(!HubClaudeStaticIdentity.Same(held.Before,altered),"changed-file-id-rejected");
      altered=held.Before;altered.SizeLow++;Check(!HubClaudeStaticIdentity.Same(held.Before,altered),"changed-size-rejected");
      altered=held.Before;altered.VolumeSerial++;Check(!HubClaudeStaticIdentity.Same(held.Before,altered),"changed-volume-rejected");
      bool deleted=DeleteFileW(alias);int deleteError=Marshal.GetLastWin32Error();
      observations.Add(new {operation="delete-unheld-alias",succeeded=deleted,nativeError=deleted?0:deleteError});
      Check(deleted || deleteError==32,"unheld-alias-delete-measured");
      if(deleted) {
        bool linkRejected=false;try{held.Verify();}catch(HubClaudeStaticIdentity.Rejected e){linkRejected=e.Code=="STATIC_IDENTITY_CHANGED";}
        Check(linkRejected,"actual-link-removal-fails-identity-gate");
      } else {
        bool added=CreateHardLinkW(extra,source,IntPtr.Zero);int addError=Marshal.GetLastWin32Error();
        observations.Add(new {operation="create-unheld-alias",succeeded=added,nativeError=added?0:addError});
        Check(added,"owned-link-addition-positive-control");
        bool linkRejected=false;try{held.Verify();}catch(HubClaudeStaticIdentity.Rejected e){linkRejected=e.Code=="STATIC_IDENTITY_CHANGED";}
        Check(linkRejected,"actual-link-addition-fails-identity-gate");
      }
      Check(HubClaudeStaticIdentity.Hash(held.Stream)==hash,"unheld-alias-deletion-keeps-held-bytes");
    }
    if(!File.Exists(alias))Check(CreateHardLinkW(alias,source,IntPtr.Zero),"owned-alias-recreated-after-release");
    if(File.Exists(extra))Check(DeleteFileW(extra),"owned-extra-alias-removed-after-release");
    using(SafeFileHandle writer=HubClaudeStaticIdentity.CreateFileW(alias,0x40000000,7,IntPtr.Zero,3,0,IntPtr.Zero)) {
      Check(!writer.IsInvalid,"released-alias-writer-positive-control");Check(PinDenied(source),"existing-alias-writer-blocks-pin");
    }
    IntPtr mapping=IntPtr.Zero,view=IntPtr.Zero;
    try {
      using(SafeFileHandle writer=HubClaudeStaticIdentity.CreateFileW(alias,0xc0000000,7,IntPtr.Zero,3,0,IntPtr.Zero)) {
        Check(!writer.IsInvalid,"mapping-writer-positive-control");
        mapping=CreateFileMappingW(writer,IntPtr.Zero,4,0,0,null);Check(mapping!=IntPtr.Zero,"owned-writable-mapping-created");
        view=MapViewOfFile(mapping,2,0,0,UIntPtr.Zero);Check(view!=IntPtr.Zero,"owned-writable-view-created");
      }
      // The writer HANDLE is closed: the live mapped writable view is the conflict.
      Check(PinDenied(source),"existing-writable-view-blocks-pin");
    } finally {if(view!=IntPtr.Zero)Check(UnmapViewOfFile(view),"owned-view-closed");if(mapping!=IntPtr.Zero)Check(CloseHandle(mapping),"owned-mapping-closed");}
    using(HubClaudeStaticIdentity.HeldFile held=new HubClaudeStaticIdentity.HeldFile(source,4096)) {held.Verify();Check(true,"released-mapping-pin-positive-control");}
    Check(MoveFileExW(alias,renamed,0),"released-alias-rename-positive-control");
    Check(DeleteFileW(renamed),"released-alias-delete-positive-control");
    using(HubClaudeStaticIdentity.HeldFile held=new HubClaudeStaticIdentity.HeldFile(source,4096)) {
      Check(held.Before.Links==1,"released-link-count-observed");
      FileAttributes original=File.GetAttributes(source);
      try {File.SetAttributes(source,original|FileAttributes.Hidden);bool rejected=false;try{held.Verify();}catch(HubClaudeStaticIdentity.Rejected e){rejected=e.Code=="STATIC_IDENTITY_CHANGED";}Check(rejected,"changed-handle-metadata-rejected");}
      finally {File.SetAttributes(source,original);}
    }
    using(HubClaudeStaticIdentity.HeldFile held=new HubClaudeStaticIdentity.HeldFile(source,4096)) {
      held.Handle.Dispose();bool rejected=false;try{held.Verify();}catch{rejected=true;}Check(rejected,"closed-handle-query-fails-closed");
    }
    foreach(string invalid in new string[]{source+":other",root+"\\..\\source.bin",source+".",source+" ",source+"\n"}) {
      bool rejected=false;try{HubClaudeStaticIdentity.Absolute(invalid);}catch(HubClaudeStaticIdentity.Rejected e){rejected=e.Code=="STATIC_PATH_REJECTED";}Check(rejected,"invalid-path-rejected-"+cases.Count);
    }
    WriteNew(ads);
    using(SafeFileHandle stream=HubClaudeStaticIdentity.CreateFileW(ads+":extra",0x40000000,0,IntPtr.Zero,1,0,IntPtr.Zero)) {
      Check(!stream.IsInvalid,"owned-alternate-stream-created");using(FileStream data=new FileStream(stream,FileAccess.Write))data.WriteByte(7);
    }
    bool streamRejected=false;
    try{using(HubClaudeStaticIdentity.HeldFile held=new HubClaudeStaticIdentity.HeldFile(ads,4096)) {}}
    catch(HubClaudeStaticIdentity.Rejected e){streamRejected=e.Code=="STATIC_ADS_REJECTED";}
    Check(streamRejected,"alternate-stream-rejected");
    Check(DeleteFileW(ads+":extra"),"owned-alternate-stream-removed");
  }
  public static int Main(string[] args) {
    string root=null,error=null;int nativeError=0;bool cleanup=false,created=false;
    try {
      if(args.Length!=1)throw new Exception("fixture-argument-rejected");
      string parent=HubClaudeStaticIdentity.Absolute(args[0]);
      root=Path.Combine(parent,"owned-static-share-"+Guid.NewGuid().ToString("N"));
      if(!CreateDirectoryW(root,IntPtr.Zero))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"fixture-create-failed");
      created=true;Run(root);
    } catch(Exception e){error=e is HubClaudeStaticIdentity.Rejected?((HubClaudeStaticIdentity.Rejected)e).Code:e.Message;nativeError=e is System.ComponentModel.Win32Exception?((System.ComponentModel.Win32Exception)e).NativeErrorCode:e is HubClaudeStaticIdentity.Rejected?((HubClaudeStaticIdentity.Rejected)e).NativeError:0;}
    finally {
      if(created && root!=null && Directory.Exists(root)) {
        try {
          // Never recurse: every deleted leaf is a fixed name owned by this fixture.
          foreach(string leaf in new string[]{"source.bin","alias.bin","renamed.bin","extra.bin","ads.bin"}) {string file=Path.Combine(root,leaf);if(File.Exists(file))File.Delete(file);}
          Directory.Delete(root,false);cleanup=!Directory.Exists(root);
        } catch {cleanup=false;}
      }
    }
    bool passed=error==null&&cleanup;
    Console.WriteLine(new JavaScriptSerializer().Serialize(new {schemaVersion=1,kind="owned-static-share-test",passed,cleanupVerified=cleanup,cases,observations,error,nativeError,vendorExecuted=false,profileCreated=false}));
    return passed?0:1;
  }
}
