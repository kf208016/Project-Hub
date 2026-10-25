// Pure lifecycle regression: no native handles, directories, profile or provider.
using System;
using System.IO;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.Serialization;

class PinnedRootLifecycleSelfTest {
  static int checks;
  static readonly BindingFlags PrivateInstance=BindingFlags.Instance|BindingFlags.NonPublic;
  static HubPinnedRoot EmptyOwnedShell() {
    // Own only managed collections. Bypass the native-opening constructor on purpose.
    HubPinnedRoot pin=(HubPinnedRoot)FormatterServices.GetUninitializedObject(typeof(HubPinnedRoot));
    typeof(HubPinnedRoot).GetField("handles",PrivateInstance).SetValue(pin,new List<IntPtr>());
    typeof(HubPinnedRoot).GetField("names",PrivateInstance).SetValue(pin,new List<string>{"owned-pure-fixture"});
    return pin;
  }
  static void Check(bool value,string code) {if(!value)throw new Exception(code);checks++;}
  static void Rejected(Action action,string code) {
    Exception observed=null;try{action();}catch(TargetInvocationException error){observed=error.InnerException;}catch(Exception error){observed=error;}
    Check(observed is IOException && observed.Message=="Directory identity pin rejected",code+":"+(observed==null?"none":observed.GetType().Name));
  }
  static int Count(HubPinnedRoot pin,string field) {return ((System.Collections.ICollection)typeof(HubPinnedRoot).GetField(field,PrivateInstance).GetValue(pin)).Count;}
  public static int Main(string[] args) {
    try {
      Check(args.Length==0,"arguments-rejected");
      HubPinnedRoot pin=EmptyOwnedShell();
      pin.Dispose();
      Rejected(delegate{pin.Verify();},"verify-after-dispose");
      Rejected(delegate{typeof(HubPinnedRoot).GetMethod("CurrentFingerprint",PrivateInstance).Invoke(pin,null);},"fingerprint-after-dispose");
      Check(Count(pin,"handles")==0 && Count(pin,"names")==0,"both-managed-collections-cleared");
      pin.Dispose();pin.Dispose();
      Check(Count(pin,"handles")==0 && Count(pin,"names")==0,"repeated-dispose-is-idempotent");
      Rejected(delegate{pin.Verify();},"verify-after-repeated-dispose");
      Rejected(delegate{typeof(HubPinnedRoot).GetMethod("CurrentFingerprint",PrivateInstance).Invoke(pin,null);},"fingerprint-after-repeated-dispose");
      using(HubPinnedRoot incomplete=EmptyOwnedShell()) {
        Rejected(delegate{incomplete.Verify();},"incomplete-empty-pin-rejected");
        Rejected(delegate{typeof(HubPinnedRoot).GetMethod("CurrentFingerprint",PrivateInstance).Invoke(incomplete,null);},"incomplete-fingerprint-rejected");
      }
      Console.WriteLine("Pinned root pure lifecycle checks passed: "+checks);return 0;
    } catch(Exception error){Console.WriteLine(error.Message);return 1;}
  }
}
