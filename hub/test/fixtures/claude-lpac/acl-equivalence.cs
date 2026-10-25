// Pure in-memory ACL regression harness, compiled with an explicit /main.
// Uses synthetic SIDs only; no profile, filesystem ACL, process or cleanup API.
using System;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;

static class ProbeAclSelfTest {
  const string Owner="S-1-5-21-1-2-3-1001",OtherOwner="S-1-5-21-1-2-3-1002";
  const string Package="S-1-15-2-1-2-3-4-5-6-7",OtherPackage="S-1-15-2-7-6-5-4-3-2-1";
  const string Directory="O:"+Owner+"D:P(A;OICI;FA;;;"+Owner+")(A;OICI;0x1200a9;;;"+Package+")";
  const string File="O:"+Owner+"D:P(A;OICI;FA;;;"+Owner+")(A;;0x1200a9;;;"+Package+")";
  static int assertions;
  static readonly MethodInfo Matcher=typeof(HubClaudeLpacProbe).GetMethod("PrivateAclMatches",BindingFlags.Static|BindingFlags.NonPublic);
  static void Check(bool value,string label){assertions++;if(!value)throw new Exception(label);}
  static RawSecurityDescriptor Parse(string sddl){return new RawSecurityDescriptor(sddl);}
  static RawSecurityDescriptor Clone(RawSecurityDescriptor source){byte[] bytes=new byte[source.BinaryLength];source.GetBinaryForm(bytes,0);return new RawSecurityDescriptor(bytes,0);}
  static bool Matches(RawSecurityDescriptor expected,RawSecurityDescriptor observed){return (bool)Matcher.Invoke(null,new object[]{expected,observed});}
  static void Reject(string changed,string label){Check(!Matches(Parse(Directory),Parse(changed)),label);}
  static void FlagDifference(ControlFlags flag){RawSecurityDescriptor expected=Parse(Directory),observed=Clone(expected);observed.SetFlags(observed.ControlFlags^flag);Check(!Matches(expected,observed),"control flag must agree: "+flag);}
  static int Main(){
    Check(Matcher!=null,"private comparator exists");
    foreach(string sddl in new string[]{Directory,File,"O:"+Owner+"D:P(A;OICI;FA;;;"+Owner+")"}){
      RawSecurityDescriptor expected=Parse(sddl),observed=Clone(expected);
      Check(Matches(expected,observed),"identical protected ACL");
      observed.SetFlags(observed.ControlFlags|ControlFlags.DiscretionaryAclAutoInherited);
      Check(Matches(expected,observed),"AI bookkeeping alone is allowed");
      Check(Matches(observed,expected),"AI bookkeeping comparison is symmetric");
    }
    Reject(Directory.Replace("O:"+Owner,"O:"+OtherOwner),"owner drift");
    Reject(Directory.Replace(Package,OtherPackage),"package SID drift");
    Reject(Directory.Replace("0x1200a9","0x1301bf"),"package write grant");
    Reject(Directory.Replace(";FA;",";FR;"),"owner rights drift");
    Reject(Directory+"(A;;FR;;;WD)","extra public grant");
    Reject("O:"+Owner+"D:P(A;OICI;FA;;;"+Owner+")","missing package ACE");
    Reject(Directory.Replace("(A;OICI;0x1200a9","(D;OICI;0x1200a9"),"ACE type drift");
    foreach(string flags in new string[]{"OI","CI","OICINP","OICIIO","OICIID"})Reject(Directory.Replace("(A;OICI;0x1200a9","(A;"+flags+";0x1200a9"),"ACE inheritance or propagation drift: "+flags);
    Reject("O:"+Owner+"D:P(A;OICI;0x1200a9;;;"+Package+")(A;OICI;FA;;;"+Owner+")","ACE ordering drift");
    Reject(Directory+"(A;OICI;0x1200a9;;;"+Package+")","duplicate ACE");
    // RawSecurityDescriptor always forces SelfRelative; every other non-AI
    // control flag can be varied here and must remain an exact match.
    foreach(ControlFlags flag in new ControlFlags[]{ControlFlags.OwnerDefaulted,ControlFlags.GroupDefaulted,ControlFlags.DiscretionaryAclPresent,ControlFlags.DiscretionaryAclDefaulted,ControlFlags.SystemAclPresent,ControlFlags.SystemAclDefaulted,ControlFlags.DiscretionaryAclUntrusted,ControlFlags.ServerSecurity,ControlFlags.DiscretionaryAclAutoInheritRequired,ControlFlags.SystemAclAutoInheritRequired,ControlFlags.SystemAclAutoInherited,ControlFlags.DiscretionaryAclProtected,ControlFlags.SystemAclProtected,ControlFlags.RMControlValid})FlagDifference(flag);
    RawSecurityDescriptor baseline=Parse(Directory),revision=Clone(baseline);
    RawAcl differentRevision=new RawAcl(4,baseline.DiscretionaryAcl.Count);
    for(int i=0;i<baseline.DiscretionaryAcl.Count;i++)differentRevision.InsertAce(i,baseline.DiscretionaryAcl[i]);
    revision.DiscretionaryAcl=differentRevision;
    Check(!Matches(baseline,revision),"ACL binary revision drift");
    RawSecurityDescriptor nullAcl=Clone(baseline);nullAcl.DiscretionaryAcl=null;
    Check(!Matches(baseline,nullAcl),"null observed DACL");
    Check(!Matches(nullAcl,nullAcl),"two null DACLs are not valid private ACLs");
    RawSecurityDescriptor emptyAcl=Clone(baseline);emptyAcl.DiscretionaryAcl=new RawAcl(2,0);
    Check(!Matches(baseline,emptyAcl),"empty DACL differs from required grants");
    RawSecurityDescriptor noOwner=Clone(baseline);noOwner.Owner=null;
    Check(!Matches(baseline,noOwner),"missing observed owner");
    Check(!Matches(noOwner,noOwner),"two missing owners cannot pass");
    RawSecurityDescriptor unprotected=Clone(baseline);unprotected.SetFlags(unprotected.ControlFlags&~ControlFlags.DiscretionaryAclProtected);
    Check(!Matches(unprotected,unprotected),"unprotected descriptors cannot pass");
    Check(!Matches(null,baseline)&&!Matches(baseline,null),"missing descriptor");
    Console.WriteLine("ACL descriptor checks passed: "+assertions);return 0;
  }
}
