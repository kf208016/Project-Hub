// Test-only exact synthetic conflict / journal corruption. No user credential,
// UI or SSH capability. Journal mutations are confined to the last probe record.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using C=HubSshMaintenanceCommon;

class HubSshMaintenanceConflictFixture {
  static int Main() {
    byte[] secret=null,readback=null;
    try {
      string encoded=Environment.GetEnvironmentVariable("HUB_MAINTENANCE_FIXTURE_REQUEST");
      Environment.SetEnvironmentVariable("HUB_MAINTENANCE_FIXTURE_REQUEST",null);
      C.Require(encoded!=null&&encoded.Length<=20000,"FIXTURE_REQUEST_REJECTED");
      var request=C.Parse(C.Utf8.GetString(Convert.FromBase64String(encoded)));
      C.Fields(request,"mode","descriptor");string mode=C.Str(request,"mode",20);
      C.Require(mode=="create-conflict"||mode=="remove-conflict"||mode=="corrupt-journal"||mode=="restore-journal","FIXTURE_MODE_REJECTED");
      var descriptor=request["descriptor"] as Dictionary<string,object>;C.Validate(descriptor);
      string root=(string)descriptor["root"];
      C.Require((string)descriptor["host"]=="127.0.0.1"&&(string)descriptor["user"]=="fixture"&&Regex.IsMatch(Path.GetFileName(root),"^vault-maintenance-[a-f0-9]{12}-d$"),"FIXTURE_IDENTITY_REJECTED");
      using(var pin=new HubPinnedRoot(root,(string)descriptor["rootFingerprint"])) {
        C.RootAcl(root);
        using(var gate=C.Gate(root,"registration.lock")) {
          if(mode=="corrupt-journal"||mode=="restore-journal") {
            string recordPath=Path.Combine(root,"migration-0003.bin"),backupPath=Path.Combine(root,"fixture-journal-original.bin");
            if(mode=="corrupt-journal") {
              C.RequireAbsentPath(backupPath,"FIXTURE_BACKUP_EXISTS");
              byte[] original;using(var stream=C.HoldFile(recordPath,65536))original=C.Read(stream);
              var record=C.UnprotectFile(recordPath);
              C.Require(C.Str(record,"event",32)=="probe-1"&&C.Num(record,"sequence",3,3)==3,"FIXTURE_JOURNAL_REJECTED");
              C.RequireAbsentPath(Path.Combine(root,"migration-0004.bin"),"FIXTURE_JOURNAL_NOT_LAST");
              C.CreateFile(backupPath,original);
              record["details"]=new Dictionary<string,object>{{"uid",1000}};
              File.WriteAllBytes(recordPath,C.Protected(C.Canon(record)));
            } else {
              var originalRecord=C.UnprotectFile(backupPath);
              C.Require(C.Str(originalRecord,"event",32)=="probe-1"&&C.Num(originalRecord,"sequence",3,3)==3,"FIXTURE_JOURNAL_REJECTED");
              byte[] original;using(var stream=C.HoldFile(backupPath,65536))original=C.Read(stream);
              File.WriteAllBytes(recordPath,original);
              using(var stream=C.HoldFile(recordPath,65536))C.Require(C.Hash(C.Read(stream))==C.Hash(original),"FIXTURE_RESTORE_FAILED");
              File.Delete(backupPath);
            }
            pin.Verify();Console.WriteLine("{\"ok\":true,\"state\":\""+(mode=="corrupt-journal"?"corrupted":"restored")+"\"}");return 0;
          }
          string target=C.Target(descriptor),marker=Path.Combine(root,"fixture-conflict.bin");
          var expected=new Dictionary<string,object>{{"binding",C.Binding(descriptor)},{"target",target},{"state","synthetic-conflict-intent"}};
          secret=C.Utf8.GetBytes(" Hub fixture 密碼 🔐 42 ");
          if(mode=="create-conflict") {
            C.RequireAbsentPath(marker,"FIXTURE_MARKER_EXISTS");
            C.Require(!HubSshVaultStore.Exists(target),"FIXTURE_CREDENTIAL_EXISTS");
            C.CreateFile(marker,C.Protected(C.Canon(expected)));
            C.Require(C.Canon(C.UnprotectFile(marker))==C.Canon(expected),"FIXTURE_MARKER_CHANGED");
            HubSshVaultStore.Create(target,"fixture",secret);
          } else {
            C.Require(C.Canon(C.UnprotectFile(marker))==C.Canon(expected),"FIXTURE_MARKER_CHANGED");
          }
          readback=HubSshVaultStore.Read(target,"fixture");
          C.Require(readback.Length==secret.Length,"FIXTURE_CONTENT_CHANGED");
          int mismatch=0;for(int i=0;i<secret.Length;i++)mismatch|=readback[i]^secret[i];
          C.Require(mismatch==0,"FIXTURE_CONTENT_CHANGED");pin.Verify();C.RootAcl(root);
          if(mode=="remove-conflict") {
            HubSshVaultStore.Delete(target);C.Require(!HubSshVaultStore.Exists(target),"FIXTURE_DELETE_UNCONFIRMED");File.Delete(marker);
          }
          Console.WriteLine("{\"ok\":true,\"state\":\""+(mode=="create-conflict"?"created":"removed")+"\"}");return 0;
        }
      }
    }catch(Exception error){Console.WriteLine("{\"ok\":false,\"code\":\""+C.Error(error)+"\"}");return 125;}
    finally{if(secret!=null)Array.Clear(secret,0,secret.Length);if(readback!=null)Array.Clear(readback,0,readback.Length);}
  }
}
